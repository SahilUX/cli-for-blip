// Own launcher for Blip's native C hosting ABI: Linux 1.2.6, macOS 1.2.3.
// It does not launch the desktop frontend. Mac uses the intact BlipKit framework.
#ifdef __APPLE__
#define _DARWIN_C_SOURCE
#endif
#define _XOPEN_SOURCE 700
#include <dlfcn.h>
#include <signal.h>
#include <stdio.h>
#include <string.h>
#include <time.h>
#ifdef __APPLE__
#include <stdlib.h>
#include <unistd.h>
#include <sys/sysctl.h>
#endif

static volatile sig_atomic_t stopping;
static void request_stop(int signal) { (void)signal; stopping = 1; }

int main(int argc, char **argv) {
#ifdef __APPLE__
    // Query only metadata for a process owned by this user. The start timestamp
    // distinguishes a daemon from an unrelated process that reused its PID.
    if (argc == 3 && strcmp(argv[1], "--identity") == 0) {
        char *end;
        long pid = strtol(argv[2], &end, 10);
        if (*end || pid <= 0 || pid > 2147483647L) return 2;
        // Unlike proc_pidinfo, sysctl also describes other users' processes
        // and zombies, so a reused PID reads as "not ours" instead of an error.
        int name[4] = {CTL_KERN, KERN_PROC, KERN_PROC_PID, (int)pid};
        struct kinfo_proc info;
        size_t length = sizeof(info);
        if (sysctl(name, 4, &info, &length, NULL, 0) != 0) return 3;
        if (length == 0 || info.kp_eproc.e_ucred.cr_uid != getuid() || info.kp_proc.p_stat == SZOMB) return 4;
        printf("%d %d %llu:%llu\n", info.kp_proc.p_pid, info.kp_eproc.e_pgid,
               (unsigned long long)info.kp_proc.p_starttime.tv_sec, (unsigned long long)info.kp_proc.p_starttime.tv_usec);
        return 0;
    }
#endif
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
    // Go's c-shared runtime needs SA_ONSTACK on handlers installed after it loads.
    action.sa_flags = SA_ONSTACK;
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
