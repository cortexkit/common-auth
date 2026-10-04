#include <node_api.h>
#include <sys/file.h>
#include <fcntl.h>
#include <unistd.h>
#include <errno.h>
#include <stdlib.h>
#include <string.h>

typedef struct { int fd; } handle;
static void cleanup(napi_env env, void *data, void *hint) {
  (void)env; (void)hint;
  handle *h = data;
  if (h->fd >= 0) close(h->fd);
  free(h);
}
static napi_value try_lock(napi_env env, napi_callback_info info) {
  size_t argc = 1, size = 0;
  napi_value arg, result;
  napi_get_cb_info(env, info, &argc, &arg, NULL, NULL);
  if (argc != 1 || napi_get_value_string_utf8(env, arg, NULL, 0, &size) != napi_ok) {
    napi_throw_type_error(env, NULL, "tryLock requires a path"); return NULL;
  }
  char *path = malloc(size + 1);
  if (!path) { napi_throw_error(env, NULL, "allocation failed"); return NULL; }
  napi_get_value_string_utf8(env, arg, path, size + 1, &size);
  int fd = open(path, O_CREAT | O_RDWR | O_CLOEXEC | O_NOFOLLOW, 0600);
  free(path);
  if (fd < 0) { napi_throw_error(env, NULL, strerror(errno)); return NULL; }
  if (flock(fd, LOCK_EX | LOCK_NB) != 0) {
    int error = errno; close(fd);
    if (error == EWOULDBLOCK || error == EAGAIN) { napi_get_null(env, &result); return result; }
    napi_throw_error(env, NULL, strerror(error)); return NULL;
  }
  handle *h = malloc(sizeof(*h));
  if (!h) { close(fd); napi_throw_error(env, NULL, "allocation failed"); return NULL; }
  h->fd = fd;
  if (napi_create_external(env, h, cleanup, NULL, &result) != napi_ok) {
    cleanup(env, h, NULL); napi_throw_error(env, NULL, "handle creation failed"); return NULL;
  }
  return result;
}
static napi_value unlock(napi_env env, napi_callback_info info) {
  size_t argc = 1; napi_value arg, result; handle *h;
  napi_get_cb_info(env, info, &argc, &arg, NULL, NULL);
  if (argc != 1 || napi_get_value_external(env, arg, (void **)&h) != napi_ok) {
    napi_throw_type_error(env, NULL, "unlock requires a handle"); return NULL;
  }
  if (h->fd >= 0) {
    int fd = h->fd; h->fd = -1;
    int rc = flock(fd, LOCK_UN), error = errno; close(fd);
    if (rc != 0) { napi_throw_error(env, NULL, strerror(error)); return NULL; }
  }
  napi_get_undefined(env, &result); return result;
}
static napi_value init(napi_env env, napi_value exports) {
  napi_property_descriptor props[] = {
    {"tryLock", NULL, try_lock, NULL, NULL, NULL, napi_default, NULL},
    {"unlock", NULL, unlock, NULL, NULL, NULL, napi_default, NULL}
  };
  napi_define_properties(env, exports, 2, props); return exports;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME, init)
