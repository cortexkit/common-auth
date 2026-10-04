#include <sys/file.h>
#include <sys/wait.h>
#include <fcntl.h>
#include <unistd.h>
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
static int attempt(int fd, int kind) {
  if (kind == 0) return flock(fd, LOCK_EX | LOCK_NB);
  if (kind == 2) { lseek(fd, 0, SEEK_SET); return lockf(fd, F_TLOCK, 1); }
  struct flock l = {0}; l.l_type = F_WRLCK; l.l_whence = SEEK_SET; l.l_len = 1;
  #ifdef F_OFD_SETLK
  if (kind == 3) return fcntl(fd, F_OFD_SETLK, &l);
#endif
  return fcntl(fd, F_SETLK, &l);
}
static int child_attempt(const char *path, int kind) {
  pid_t p = fork();
  if (p == 0) { int fd = open(path, O_RDWR); _exit(attempt(fd, kind) == 0 ? 0 : 1); }
  int status; waitpid(p, &status, 0); return WEXITSTATUS(status) == 0;
}
int main(int argc, char **argv) {
  if (argc != 2) return 2;
  #ifdef F_OFD_SETLK
  int kinds = 4;
#else
  int kinds = 3;
#endif
  for (int k = 0; k < kinds; k++) {
    int a = open(argv[1], O_CREAT | O_RDWR, 0600), b = open(argv[1], O_RDWR);
    int first = attempt(a, k) == 0, second = attempt(b, k) == 0;
    int before = child_attempt(argv[1], k);
    int unrelated = open(argv[1], O_RDWR); close(unrelated);
    int after = child_attempt(argv[1], k);
    printf("{\"primitive\":\"%s\",\"first_acquired\":%s,\"second_open_acquired\":%s,\"child_before_close_acquired\":%s,\"child_after_close_acquired\":%s}\n",
      k == 0 ? "flock" : k == 1 ? "fcntl" : k == 2 ? "lockf" : "OFD", first?"true":"false", second?"true":"false", before?"true":"false", after?"true":"false");
    close(b); close(a);
  }
#ifndef F_OFD_SETLK
  puts("{\"primitive\":\"OFD\",\"available\":false,\"two_opens\":\"not runnable\",\"unrelated_close\":\"not runnable\"}");
#endif
  return 0;
}
