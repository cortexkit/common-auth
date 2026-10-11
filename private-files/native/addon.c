#define WIN32_LEAN_AND_MEAN
#define _WIN32_WINNT 0x0602
#define NAPI_VERSION 8
#include <windows.h>
#include <aclapi.h>
#include <sddl.h>
#include <node_api.h>
#include <stdlib.h>
#include <stdint.h>
#include <string.h>
#include <wchar.h>
#include <winternl.h>
#include <winioctl.h>
#include "open-policy.h"

typedef char OpenPolicyMatchesWindowsSdk[
    PF_READ_CONTROL == READ_CONTROL && PF_WRITE_DAC == WRITE_DAC &&
    PF_READ_ATTRIBUTES == FILE_READ_ATTRIBUTES && PF_SYNCHRONIZE == SYNCHRONIZE &&
    PF_GENERIC_READ == GENERIC_READ && PF_GENERIC_WRITE == GENERIC_WRITE &&
    PF_DELETE == DELETE ? 1 : -1];
typedef char ReparseQueryNeedsNoDataAccess[
    ((FSCTL_GET_REPARSE_POINT >> 14) & 3) == FILE_ANY_ACCESS ? 1 : -1];

/* Each transaction owns all handles until completion. Ancestors deny delete
 * sharing so an ordinary other user cannot replace a traversed component. */
typedef struct {
  napi_env env;
  napi_async_work work;
  napi_deferred deferred;
  wchar_t *path;
  int op, directory;
  BYTE *bytes;
  size_t length;
  DWORD error;
  const char *reason;
  HANDLE *ancestors;
  size_t count;
  HANDLE leaf;
  PSECURITY_DESCRIPTOR token;
  PSID sid;
  void *owner_token;
  PSID default_owner;
  const char *refusal;
  LPWSTR detail;
  DWORD mask;
  int created;
} Job;

static void fail(Job *j, DWORD error, const char *reason) {
  if (!j->reason) { j->error = error; j->reason = reason; }
}

static int user_sid(Job *j) {
  HANDLE token = NULL;
  DWORD size = 0;
  /* The process token is the contract; thread impersonation is not supported. */
  if (OpenThreadToken(GetCurrentThread(), TOKEN_QUERY, TRUE, &token)) {
    CloseHandle(token);
    fail(j, ERROR_NOT_SUPPORTED, "Impersonation is unsupported"); return 0;
  }
  if (GetLastError() != ERROR_NO_TOKEN ||
      !OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) {
    fail(j, GetLastError(), "Cannot query process user SID"); return 0;
  }
  GetTokenInformation(token, TokenUser, NULL, 0, &size);
  j->token = malloc(size);
  if (!j->token) { CloseHandle(token); fail(j, ERROR_OUTOFMEMORY, "Token allocation failed"); return 0; }
  if (!GetTokenInformation(token, TokenUser, j->token, size, &size)) {
    fail(j, GetLastError(), "Cannot query process user SID"); CloseHandle(token); return 0;
  }
  DWORD owner_size = 0;
  GetTokenInformation(token, TokenOwner, NULL, 0, &owner_size);
  j->owner_token = malloc(owner_size);
  if (!j->owner_token || !GetTokenInformation(token, TokenOwner, j->owner_token, owner_size, &owner_size)) {
    fail(j, GetLastError(), "Cannot query token default owner SID"); CloseHandle(token); return 0;
  }
  j->default_owner = ((TOKEN_OWNER *)j->owner_token)->Owner;
  CloseHandle(token);
  j->sid = ((TOKEN_USER *)j->token)->User.Sid;
  return 1;
}

static int attributes(Job *j, HANDLE h, int directory) {
  BY_HANDLE_FILE_INFORMATION info;
  if (GetFileType(h) != FILE_TYPE_DISK) {
    fail(j, ERROR_ACCESS_DENIED, "Only ordinary disk objects are supported"); return 0;
  }
  if (!GetFileInformationByHandle(h, &info)) {
    if (GetLastError() != ERROR_ACCESS_DENIED) {
      fail(j, GetLastError(), "Cannot inspect opened object attributes"); return 0;
    }
    /* Security-query handles have no attribute-access permission. StandardInfo
     * and the reparse query use no file-data rights; uncertain results refuse. */
    FILE_STANDARD_INFO standard;
    if (!GetFileInformationByHandleEx(h, FileStandardInfo, &standard, sizeof(standard))) {
      fail(j, GetLastError(), "Cannot inspect object kind with security-only rights"); return 0;
    }
    BYTE *buffer = malloc(MAXIMUM_REPARSE_DATA_BUFFER_SIZE);
    OVERLAPPED overlap;
    memset(&overlap, 0, sizeof(overlap));
    overlap.hEvent = CreateEventW(NULL, TRUE, FALSE, NULL);
    if (!buffer || !overlap.hEvent) {
      free(buffer); if (overlap.hEvent) CloseHandle(overlap.hEvent);
      fail(j, ERROR_OUTOFMEMORY, "Reparse query allocation failed"); return 0;
    }
    DWORD received = 0;
    BOOL reparse = DeviceIoControl(h, FSCTL_GET_REPARSE_POINT, NULL, 0,
        buffer, MAXIMUM_REPARSE_DATA_BUFFER_SIZE, &received, &overlap);
    DWORD error = reparse ? ERROR_SUCCESS : GetLastError();
    if (!reparse && error == ERROR_IO_PENDING) {
      reparse = GetOverlappedResult(h, &overlap, &received, TRUE);
      error = reparse ? ERROR_SUCCESS : GetLastError();
    }
    CloseHandle(overlap.hEvent); free(buffer);
    if (!reparse && error != ERROR_NOT_A_REPARSE_POINT) {
      fail(j, error, "Cannot exclude reparse points with security-only rights"); return 0;
    }
    info.dwFileAttributes = (standard.Directory ? FILE_ATTRIBUTE_DIRECTORY : 0) |
        (reparse ? FILE_ATTRIBUTE_REPARSE_POINT : 0);
  }
  if (info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) {
    j->refusal = "reparse-point";
    fail(j, ERROR_ACCESS_DENIED, "Reparse points (including ancestors) are forbidden"); return 0;
  }
  if (directory == -1) j->directory = !!(info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY);
  else if (!!(info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) != directory) {
    j->refusal = "wrong-kind";
    fail(j, ERROR_ACCESS_DENIED, "Object kind does not match"); return 0;
  }
  return 1;
}

static int descriptor(Job *j, HANDLE h, int canonical) {
  PSID owner = NULL;
  PACL acl = NULL;
  PSECURITY_DESCRIPTOR sd = NULL;
  SECURITY_DESCRIPTOR_CONTROL control = 0;
  DWORD revision;
  DWORD error = GetSecurityInfo(h, SE_FILE_OBJECT,
      OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION, &owner, NULL, &acl, NULL, &sd);
  if (error != ERROR_SUCCESS) {
    j->refusal = "unsupported-filesystem";
    fail(j, error, "Filesystem cannot return a Windows owner/DACL; use local NTFS"); return 0;
  }
  /* Reads accept TokenOwner from the process token (often Administrators when
   * elevated), matching Rust writers that leave ownership at the Windows default.
   * Permission replacement only modifies objects owned by the user SID itself. */
  int valid = owner && (EqualSid(owner, j->sid) ||
      (canonical && EqualSid(owner, j->default_owner)));
  if (!valid) {
    j->refusal = "wrong-owner";
    if (owner) ConvertSidToStringSidW(owner, &j->detail);
    fail(j, ERROR_ACCESS_DENIED, canonical ?
        "Owner is neither the user SID nor the permitted token default owner" :
        "Permission replacement requires the user SID as owner; ownership will not be taken");
  }
  if (valid && canonical) {
    GetSecurityDescriptorControl(sd, &control, &revision);
    if (!(control & SE_DACL_PRESENT) || !acl) {
      valid = 0; j->refusal = "null-dacl";
    } else if (!IsValidAcl(acl) || !acl->AceCount) {
      valid = 0; j->refusal = "empty-dacl";
    } else {
      ACCESS_ALLOWED_ACE *ace = NULL;
      int ordinary = GetAce(acl, 0, (void **)&ace) && ace->Header.AceType == ACCESS_ALLOWED_ACE_TYPE;
      valid = ordinary && acl->AceCount == 1 && ace->Mask == FILE_ALL_ACCESS &&
          IsValidSid(&ace->SidStart) && EqualSid(&ace->SidStart, j->sid);
      if (!valid) {
        j->refusal = "extra-ace";
        /* Return the first offending ordinary ACE, rather than the safe owner ACE. */
        for (DWORD i = 0; i < acl->AceCount; ++i) {
          ACCESS_ALLOWED_ACE *entry = NULL;
          if (GetAce(acl, i, (void **)&entry) &&
              (entry->Header.AceType == ACCESS_ALLOWED_ACE_TYPE || entry->Header.AceType == ACCESS_DENIED_ACE_TYPE) &&
              IsValidSid(&entry->SidStart) &&
              (acl->AceCount == 1 || !EqualSid(&entry->SidStart, j->sid))) {
            ConvertSidToStringSidW(&entry->SidStart, &j->detail);
            j->mask = entry->Mask; break;
          }
        }
      } else if (canonical == -1) {
        /* After access-denied, reject missing/empty/foreign ACLs with security
         * query rights alone. A usable ACL still needs kind/ACE-flag checks. */
        valid = 1;
      } else if ((control & SE_DACL_PROTECTED) &&
          ace->Header.AceFlags == (j->directory ? OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE : 0)) {
        valid = 1;
      } else if (!j->directory && !(control & SE_DACL_PROTECTED) &&
          ace->Header.AceFlags == INHERITED_ACE && j->count) {
        /* Inherited files are accepted only underneath a pinned canonical private directory. */
        j->directory = 1;
        valid = descriptor(j, j->ancestors[j->count - 1], 1);
        j->directory = 0;
      } else {
        valid = 0;
        j->refusal = (control & SE_DACL_PROTECTED) ? "extra-ace" : "not-protected";
        if (control & SE_DACL_PROTECTED) {
          ConvertSidToStringSidW(&ace->SidStart, &j->detail);
          j->mask = ace->Mask;
        }
      }
    }
    if (!valid) fail(j, ERROR_ACCESS_DENIED, "Strict owner-only DACL required; explicitly migrate current-user-owned objects");
  }
  LocalFree(sd);
  return valid;
}

static int privileged_sid(PSID sid) {
  BYTE storage[SECURITY_MAX_SID_SIZE];
  DWORD size = sizeof(storage);
  if (CreateWellKnownSid(WinLocalSystemSid, NULL, storage, &size) && EqualSid(sid, storage)) return 1;
  size = sizeof(storage);
  if (CreateWellKnownSid(WinBuiltinAdministratorsSid, NULL, storage, &size) && EqualSid(sid, storage)) return 1;
  /* TrustedInstaller controls some read-only OS components. */
  PSID installer = NULL;
  int result = ConvertStringSidToSidW(L"S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464", &installer) && EqualSid(sid, installer);
  if (installer) LocalFree(installer);
  return result;
}

static int trusted_ancestor(Job *j, HANDLE h, int creation_parent) {
  PSID owner = NULL;
  PACL acl = NULL;
  PSECURITY_DESCRIPTOR sd = NULL;
  DWORD error = GetSecurityInfo(h, SE_FILE_OBJECT,
      OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION, &owner, NULL, &acl, NULL, &sd);
  if (error != ERROR_SUCCESS) {
    fail(j, error, "Ancestor ACL unavailable; use a private root on local NTFS"); return 0;
  }
  int valid = owner && (EqualSid(owner, j->sid) || privileged_sid(owner)) && acl && IsValidAcl(acl) && acl->AceCount;
  DWORD dangerous = DELETE | WRITE_DAC | WRITE_OWNER | FILE_DELETE_CHILD;
  if (creation_parent) dangerous |= FILE_ADD_FILE | FILE_ADD_SUBDIRECTORY;
  for (DWORD i = 0; valid && i < acl->AceCount; ++i) {
    ACE_HEADER *header = NULL;
    if (!GetAce(acl, i, (void **)&header)) { valid = 0; break; }
    if (header->AceFlags & INHERIT_ONLY_ACE) continue;
    if (header->AceType == ACCESS_DENIED_ACE_TYPE) continue;
    if (header->AceType != ACCESS_ALLOWED_ACE_TYPE) { valid = 0; break; }
    ACCESS_ALLOWED_ACE *ace = (ACCESS_ALLOWED_ACE *)header;
    GENERIC_MAPPING mapping = { FILE_GENERIC_READ, FILE_GENERIC_WRITE, FILE_GENERIC_EXECUTE, FILE_ALL_ACCESS };
    DWORD mask = ace->Mask;
    MapGenericMask(&mask, &mapping);
    if (!IsValidSid(&ace->SidStart) ||
        ((mask & dangerous) && !EqualSid(&ace->SidStart, j->sid) && !privileged_sid(&ace->SidStart))) valid = 0;
  }
  LocalFree(sd);
  if (!valid) {
    j->refusal = "unsafe-ancestor";
    fail(j, ERROR_ACCESS_DENIED, "Unsafe writable ancestry; move to a current-user private root on local NTFS");
  }
  return valid;
}

static HANDLE open_object(Job *j, const wchar_t *path, DWORD access, DWORD disposition, SECURITY_ATTRIBUTES *sa, int directory, int report_error) {
  HANDLE h = CreateFileW(path, access,
      FILE_SHARE_READ | FILE_SHARE_WRITE, sa, disposition,
      FILE_FLAG_OPEN_REPARSE_POINT | (directory ? FILE_FLAG_BACKUP_SEMANTICS : 0), NULL);
  if (h == INVALID_HANDLE_VALUE && report_error) fail(j, GetLastError(), "Cannot open pinned object (ACL, sharing, or path failure)");
  return h;
}

/* An empty DACL still lets its owner query/replace the DACL, but does not grant
 * synchronization or attribute access that CreateFile may also request.
 * NtCreateFile without synchronous options requests only READ_CONTROL/WRITE_DAC;
 * these security handles never read file bytes. */
static HANDLE open_exact_metadata(Job *j, DWORD access, int directory) {
  size_t length = wcslen(j->path) + 4;
  wchar_t *buffer = calloc(length + 1, sizeof(wchar_t));
  if (!buffer) { fail(j, ERROR_OUTOFMEMORY, "Metadata path allocation failed"); return INVALID_HANDLE_VALUE; }
  memcpy(buffer, L"\\??\\", 4 * sizeof(wchar_t));
  memcpy(buffer + 4, j->path, (length - 4) * sizeof(wchar_t));
  UNICODE_STRING name;
  name.Buffer = buffer;
  name.Length = (USHORT)(length * sizeof(wchar_t));
  name.MaximumLength = (USHORT)((length + 1) * sizeof(wchar_t));
  OBJECT_ATTRIBUTES object;
  memset(&object, 0, sizeof(object));
  object.Length = sizeof(object);
  object.ObjectName = &name;
  object.Attributes = OBJ_CASE_INSENSITIVE;
  IO_STATUS_BLOCK io;
  HANDLE handle = INVALID_HANDLE_VALUE;
  NTSTATUS status = NtCreateFile(&handle, access, &object, &io, NULL,
      FILE_ATTRIBUTE_NORMAL, FILE_SHARE_READ | FILE_SHARE_WRITE, FILE_OPEN,
      FILE_OPEN_REPARSE_POINT | (directory ? FILE_OPEN_FOR_BACKUP_INTENT : 0), NULL, 0);
  free(buffer);
  if (status < 0) {
    DWORD error = RtlNtStatusToDosError(status);
    fail(j, error, "Cannot open exact-rights security handle (owner/ACL/path refusal)");
    return INVALID_HANDLE_VALUE;
  }
  return handle;
}

static int pin_ancestors(Job *j) {
  size_t length = wcslen(j->path);
  /* Reject device/UNC paths, streams, relative paths and ambiguous Win32 names.
   * Callers pass an absolute local DOS path; no pathname normalization is trusted. */
  if (length < 4 || !((j->path[0] >= L'A' && j->path[0] <= L'Z') ||
      (j->path[0] >= L'a' && j->path[0] <= L'z')) || j->path[1] != L':' || j->path[2] != L'\\') {
    j->refusal = "unsupported-filesystem";
    fail(j, ERROR_NOT_SUPPORTED, "Use an absolute local drive path, not UNC/device/network paths"); return 0;
  }
  wchar_t root[4] = { j->path[0], L':', L'\\', 0 };
  if (GetDriveTypeW(root) != DRIVE_FIXED) {
    j->refusal = "unsupported-filesystem";
    fail(j, ERROR_NOT_SUPPORTED, "Only fixed local ACL-capable volumes are supported; use NTFS"); return 0;
  }
  DWORD flags = 0;
  if (!GetVolumeInformationW(root, NULL, 0, NULL, NULL, &flags, NULL, 0) || !(flags & FILE_PERSISTENT_ACLS)) {
    j->refusal = "unsupported-filesystem";
    fail(j, ERROR_NOT_SUPPORTED, "Volume cannot persist ACLs (FAT/exFAT unsupported); use NTFS"); return 0;
  }
  size_t start = 3;
  for (size_t i = 3; i <= length; ++i) {
    wchar_t c = j->path[i];
    if (c == L'/' || c == L':' || (c && c < 32) || c == L'*' || c == L'?' || c == L'"' || c == L'<' || c == L'>' || c == L'|') {
      fail(j, ERROR_INVALID_NAME, "Ambiguous path component is forbidden"); return 0;
    }
    if (c == L'\\' || !c) {
      size_t n = i - start;
      if (!n || j->path[i-1] == L'.' || j->path[i-1] == L' ') {
        fail(j, ERROR_INVALID_NAME, "Empty, dot, or trailing-space path component is forbidden"); return 0;
      }
      start = i + 1;
    }
  }
  j->ancestors = calloc(length, sizeof(HANDLE));
  if (!j->ancestors) { fail(j, ERROR_OUTOFMEMORY, "Handle allocation failed"); return 0; }
  HANDLE root_handle = open_object(j, root, READ_CONTROL | FILE_READ_ATTRIBUTES, OPEN_EXISTING, NULL, 1, 1);
  if (root_handle == INVALID_HANDLE_VALUE) return 0;
  j->ancestors[j->count++] = root_handle;
  if (!attributes(j, root_handle, 1) || !trusted_ancestor(j, root_handle,
      j->op == 0 && wcschr(j->path + 3, L'\\') == NULL)) return 0;
  for (size_t i = 3; i < length; ++i) {
    if (j->path[i] != L'\\') continue;
    wchar_t saved = j->path[i];
    j->path[i] = 0;
    HANDLE h = open_object(j, j->path, READ_CONTROL | FILE_READ_ATTRIBUTES, OPEN_EXISTING, NULL, 1, 1);
    j->path[i] = saved;
    if (h == INVALID_HANDLE_VALUE) return 0;
    j->ancestors[j->count++] = h;
    int last = wcschr(j->path + i + 1, L'\\') == NULL;
    if (!attributes(j, h, 1) || !trusted_ancestor(j, h, j->op == 0 && last)) return 0;
  }
  return 1;
}

static void execute(napi_env env, void *data) {
  (void)env;
  Job *j = data;
  PACL acl = NULL;
  if (!user_sid(j) || !pin_ancestors(j)) goto done;
  DWORD acl_size = sizeof(ACL) + sizeof(ACCESS_ALLOWED_ACE) - sizeof(DWORD) + GetLengthSid(j->sid);
  acl = malloc(acl_size);
  if (!acl) { fail(j, ERROR_OUTOFMEMORY, "ACL allocation failed"); goto done; }
  if (!InitializeAcl(acl, acl_size, ACL_REVISION) ||
      !AddAccessAllowedAceEx(acl, ACL_REVISION,
        j->directory ? OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE : 0, FILE_ALL_ACCESS, j->sid)) {
    fail(j, GetLastError(), "Cannot construct owner-only DACL"); goto done;
  }
  SECURITY_DESCRIPTOR sd;
  if (!InitializeSecurityDescriptor(&sd, SECURITY_DESCRIPTOR_REVISION) ||
      !SetSecurityDescriptorOwner(&sd, j->sid, FALSE) ||
      !SetSecurityDescriptorDacl(&sd, TRUE, acl, FALSE) ||
      !SetSecurityDescriptorControl(&sd, SE_DACL_PROTECTED, SE_DACL_PROTECTED)) {
    fail(j, GetLastError(), "Cannot construct protected security descriptor"); goto done;
  }
  SECURITY_ATTRIBUTES sa = { sizeof(sa), &sd, FALSE };
  PrivateOpenPolicy policy = private_open_policy(j->op);
  if (j->op == 0 && j->directory) {
    if (!CreateDirectoryW(j->path, &sa)) {
      fail(j, GetLastError(), "Exclusive private directory creation failed"); goto done;
    }
    j->created = 1;
  }
  j->leaf = policy.exact ? open_exact_metadata(j, policy.access, j->directory) :
      open_object(j, j->path, policy.access,
        j->op == 0 && !j->directory ? CREATE_NEW : OPEN_EXISTING,
        j->op == 0 ? &sa : NULL, j->directory, 0);
  if (j->leaf == INVALID_HANDLE_VALUE) {
    DWORD error = GetLastError();
    if (!j->reason && error == ERROR_ACCESS_DENIED && (j->op == 1 || j->op == 2)) {
      PrivateOpenPolicy fallback = private_classify_fallback();
      j->leaf = open_exact_metadata(j, fallback.access, j->directory);
      if (j->leaf == INVALID_HANDLE_VALUE || !descriptor(j, j->leaf, -1)) goto done;
      if (j->op == 1) {
        if (attributes(j, j->leaf, 0) && descriptor(j, j->leaf, 1))
          fail(j, error, "ACL is canonical but file data access was denied; no bytes were read");
        goto done;
      }
    } else { fail(j, error, "Cannot open pinned object (ACL, sharing, or path failure)"); goto done; }
  }
  if (j->op == 0) j->created = 1;
  if (j->op == 3 && !descriptor(j, j->leaf, 0)) goto done;
  if (!attributes(j, j->leaf, j->directory)) goto done;
  if (j->op == 3) {
    DWORD error = SetSecurityInfo(j->leaf, SE_FILE_OBJECT,
        DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION, NULL, NULL, acl, NULL);
    if (error != ERROR_SUCCESS) {
      fail(j, error, "Cannot apply protected DACL; use a local ACL-capable filesystem"); goto done;
    }
    if (!attributes(j, j->leaf, j->directory)) goto done;
  }
  if (!descriptor(j, j->leaf, 1)) goto done;
  if (j->op == 0 && !j->directory) {
    size_t offset = 0;
    while (offset < j->length) {
      DWORD written = 0;
      DWORD size = (DWORD)((j->length - offset) > MAXDWORD ? MAXDWORD : j->length - offset);
      if (!WriteFile(j->leaf, j->bytes + offset, size, &written, NULL) || !written) {
        fail(j, GetLastError(), "Private write failed"); goto done;
      }
      offset += written;
    }
  }
  if (j->op == 1) {
    LARGE_INTEGER size;
    if (!GetFileSizeEx(j->leaf, &size)) { fail(j, GetLastError(), "Private read size failed"); goto done; }
    if (size.QuadPart < 0 || size.QuadPart > 64 * 1024 * 1024) {
      fail(j, ERROR_FILE_TOO_LARGE, "Private reads are limited to 64 MiB"); goto done;
    }
    j->length = (size_t)size.QuadPart;
    j->bytes = malloc(j->length ? j->length : 1);
    if (!j->bytes) { fail(j, ERROR_OUTOFMEMORY, "Read allocation failed"); goto done; }
    size_t offset = 0;
    while (offset < j->length) {
      DWORD received = 0;
      if (!ReadFile(j->leaf, j->bytes + offset, (DWORD)(j->length - offset), &received, NULL) || !received) {
        fail(j, GetLastError(), "Private read failed or object changed size"); goto done;
      }
      offset += received;
    }
  }
done:
  if (j->reason && j->created && j->leaf != INVALID_HANDLE_VALUE) {
    /* Delete only the object created by this job, through its pinned handle. */
    FILE_DISPOSITION_INFO disposition = { TRUE };
    if (!SetFileInformationByHandle(j->leaf, FileDispositionInfo, &disposition, sizeof(disposition)))
      j->reason = "Private operation failed; private orphan may remain at the supplied path";
  }
  if (j->leaf != INVALID_HANDLE_VALUE) CloseHandle(j->leaf);
  for (size_t i = j->count; i > 0; --i) CloseHandle(j->ancestors[i-1]);
  free(j->ancestors); free(j->token); free(j->owner_token); free(acl);
}

static void complete(napi_env env, napi_status status, void *data) {
  Job *j = data;
  napi_value value;
  if (status != napi_ok && !j->reason) fail(j, ERROR_OPERATION_ABORTED, "Async private-files work cancelled");
  if (j->reason) {
    napi_value message, error, code, native_code, path;
    napi_create_string_utf8(env, j->reason, NAPI_AUTO_LENGTH, &message);
    napi_create_error(env, NULL, message, &error);
    napi_create_string_utf8(env, "ERR_PRIVATE_FILES_SECURITY", NAPI_AUTO_LENGTH, &code);
    napi_set_named_property(env, error, "code", code);
    napi_create_uint32(env, j->error, &native_code);
    napi_set_named_property(env, error, "win32Code", native_code);
    napi_create_string_utf16(env, (char16_t *)j->path, NAPI_AUTO_LENGTH, &path);
    napi_set_named_property(env, error, "path", path);
    napi_value reason, detail, mask;
    napi_create_string_utf8(env, j->refusal ? j->refusal : "io-error", NAPI_AUTO_LENGTH, &reason);
    napi_set_named_property(env, error, "reason", reason);
    if (j->detail) {
      napi_create_string_utf16(env, (char16_t *)j->detail, NAPI_AUTO_LENGTH, &detail);
      napi_set_named_property(env, error, j->refusal && !strcmp(j->refusal, "wrong-owner") ? "ownerSid" : "sid", detail);
    }
    napi_create_uint32(env, j->mask, &mask);
    napi_set_named_property(env, error, "mask", mask);
    napi_reject_deferred(env, j->deferred, error);
  } else {
    if (j->op == 1) napi_create_buffer_copy(env, j->length, j->bytes, NULL, &value);
    else napi_get_undefined(env, &value);
    napi_resolve_deferred(env, j->deferred, value);
  }
  napi_delete_async_work(env, j->work);
  free(j->bytes); free(j->path); if (j->detail) LocalFree(j->detail); free(j);
}

static napi_value dispatch(napi_env env, napi_callback_info info) {
  napi_value args[3], promise, name;
  size_t argc = 3, length = 0;
  void *operation;
  napi_get_cb_info(env, info, &argc, args, NULL, &operation);
  int op = (int)(intptr_t)operation;
  if (argc < (op == 1 ? 1u : 2u) ||
      napi_get_value_string_utf16(env, args[0], NULL, 0, &length) != napi_ok || !length || length > 32000) {
    napi_throw_type_error(env, NULL, "Expected an absolute Windows path and object kind"); return NULL;
  }
  Job *j = calloc(1, sizeof(Job));
  if (!j) { napi_throw_error(env, NULL, "Allocation failed"); return NULL; }
  j->path = calloc(length + 1, sizeof(wchar_t));
  j->op = op; j->leaf = INVALID_HANDLE_VALUE; j->env = env;
  if (!j->path) goto invalid;
  napi_get_value_string_utf16(env, args[0], (char16_t *)j->path, length + 1, &length);
  if (wcslen(j->path) != length) goto invalid;
  if (op != 1) {
    char kind[16]; size_t n;
    if (napi_get_value_string_utf8(env, args[1], kind, sizeof(kind), &n) != napi_ok ||
        (strcmp(kind, "file") && strcmp(kind, "directory") && !(op == 2 && !strcmp(kind, "auto")))) goto invalid;
    j->directory = !strcmp(kind, "auto") ? -1 : !strcmp(kind, "directory");
  }
  if (op == 0) {
    napi_typedarray_type type;
    void *bytes;
    napi_value buffer;
    size_t offset;
    if (argc != 3 || napi_get_typedarray_info(env, args[2], &type, &j->length, &bytes, &buffer, &offset) != napi_ok ||
        type != napi_uint8_array) goto invalid;
    j->bytes = malloc(j->length ? j->length : 1);
    if (!j->bytes) goto invalid;
    memcpy(j->bytes, bytes, j->length);
  }
  napi_create_promise(env, &j->deferred, &promise);
  napi_create_string_utf8(env, "private-files", NAPI_AUTO_LENGTH, &name);
  if (napi_create_async_work(env, NULL, name, execute, complete, j, &j->work) != napi_ok ||
      napi_queue_async_work(env, j->work) != napi_ok) {
    if (j->work) napi_delete_async_work(env, j->work);
    goto invalid;
  }
  return promise;
invalid:
  free(j->bytes); free(j->path); free(j);
  napi_throw_type_error(env, NULL, "Invalid private-files arguments or allocation failure"); return NULL;
}

static napi_value init(napi_env env, napi_value exports) {
  const char *names[] = { "create", "read", "verify", "secure" };
  for (intptr_t i = 0; i < 4; ++i) {
    napi_value fn;
    napi_create_function(env, names[i], NAPI_AUTO_LENGTH, dispatch, (void *)i, &fn);
    napi_set_named_property(env, exports, names[i], fn);
  }
  return exports;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME, init)
