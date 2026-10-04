#include <sys/file.h>
#include <sys/wait.h>
#include <fcntl.h>
#include <unistd.h>
#include <stdio.h>
int main(int argc, char **argv) {
  if (argc != 2) return 2;
  int fd = open(argv[1], O_CREAT | O_RDWR, 0600);
  if (fd < 0 || flock(fd, LOCK_EX | LOCK_NB)) return 3;
  int pipefd[2]; if (pipe(pipefd)) return 4;
  pid_t child = fork();
  if (child == 0) {
    close(pipefd[1]); char c; read(pipefd[0], &c, 1);
    int other = open(argv[1], O_RDWR), busy = flock(other, LOCK_EX | LOCK_NB) != 0;
    int inherited_unlock = flock(fd, LOCK_UN) == 0;
    int after = flock(other, LOCK_EX | LOCK_NB) == 0;
    printf("{\"parentClosed\":true,\"childInheritedKeepsBusy\":%s,\"childUnlockSucceeded\":%s,\"acquiredAfterInheritedUnlock\":%s}\n", busy?"true":"false", inherited_unlock?"true":"false", after?"true":"false");
    close(other); close(fd); return busy && inherited_unlock && after ? 0 : 5;
  }
  close(pipefd[0]); close(fd); write(pipefd[1], "x", 1); close(pipefd[1]);
  int status; waitpid(child, &status, 0); return WEXITSTATUS(status);
}
