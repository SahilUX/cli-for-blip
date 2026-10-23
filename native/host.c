// Own launcher for the C hosting ABI exported by Blip 1.2.6's native engine.
// No JVM, GUI toolkit, display server or D-Bus session is loaded.
#define _POSIX_C_SOURCE 200809L
#include <dlfcn.h>
#include <signal.h>
#include <stdio.h>
#include <string.h>
#include <time.h>

static volatile sig_atomic_t stopping;
static void request_stop(int signal) { (void)signal; stopping = 1; }

int main(int argc, char **argv) {
    const int check = argc == 3 && strcmp(argv[1], "--check") == 0;
    if (!check && argc != 4) {
        fprintf(stderr, "usage: blip-core <library> <cache directory> <data directory>\n"
                        "       blip-core --check <library>\n");
        return 2;
    }
    void *library = dlopen(argv[check ? 2 : 1], RTLD_NOW | RTLD_LOCAL);
    if (!library) { fprintf(stderr, "could not load Blip core: %s\n", dlerror()); return 1; }
    void (*host)(int, const char *, const char *, const char *, const char *);
    void (*stop)(void);
    host = (void (*)(int, const char *, const char *, const char *, const char *))dlsym(library, "libblip_host");
    stop = (void (*)(void))dlsym(library, "libblip_host_stop");
    if (!host || !stop) {
        fprintf(stderr, "unsupported Blip core: missing hosting symbols\n");
        return 1;
    }
    if (check) return 0;

    struct sigaction action = {0};
    action.sa_handler = request_stop;
    sigemptyset(&action.sa_mask);
    if (sigaction(SIGTERM, &action, NULL) || sigaction(SIGINT, &action, NULL)) {
        perror("could not install Blip core signal handlers");
        return 1;
    }
    // No takeover: another process holding the engine's lock must stay running.
    host(0, argv[2], argv[3], "https://prod.blip.net", NULL);
    while (!stopping) { const struct timespec delay = {0, 100000000}; nanosleep(&delay, NULL); }
    // Go code can keep threads alive. Stop it gracefully, then let process exit
    // release the library instead of unloading code those threads might use.
    stop();
    return 0;
}
