# CLI for Blip: rights and source review

Reviewed on October 17, 2026 against [Blip's official terms of service](https://blip.net/terms-of-service), dated January 18, 2025.

## Blip's rights

[Blip](https://blip.net/) is provided by Blip Studio Inc. Its terms reserve rights to Blip, including its trademarks and content. They grant a limited license for Blip's intended purpose and restrict trademark use without permission. They require a Business plan for commercial activities.

This project is independent and unofficial. It is not affiliated with or endorsed by Blip Studio Inc. The project's [MIT license](LICENSE) covers this repository's code and documentation. It does not grant rights to Blip's proprietary app, services, trademarks, or content. The installer downloads Blip's official archive from Blip's server; use of Blip remains subject to its terms.

## What the source review found

The tracked source at the time of review consists of a Node.js CLI, a small JavaScript DRPC/protobuf implementation, a shell installer, and documentation. The current source and the initial DRPC implementation were inspected. No Blip binaries, jars, logos, generated schema classes, or decompiled method bodies were found among those files. At that review, the installer ran Blip's official installer from Blip's server rather than bundling the app. It now downloads Blip's official archive itself and keeps only the native engine (Linux) or the signed BlipKit framework (macOS); see the sections below.

The README and source identify Blip 1.2.6 as the reverse-engineering target. The CLI contains RPC method names, event names, field numbers, enum values, and the path of an app device identifier file. These came from inspecting that version of the app. The method names and field numbers came from the Wire-generated protobuf classes in its Linux app, as the README describes. Those classes are not included in this repository. When the CLI creates the device identifier file, it writes a new random UUID and a newline, and nothing else. It uses only the first 36 characters of an existing file.

The JavaScript DRPC helper names `storj.io/drpc` v0.0.32 as its protocol reference. It uses Node's built-in modules and includes no vendored Go source. This was a review of the source files. It does not establish the origin of every line or any legal permission.

## Remaining uncertainty

The reviewed Blip terms do not mention reverse engineering, unofficial clients, or the undocumented RPC interface this client uses. No permission from Blip Studio Inc. for this project or its use of the Blip name has been established. Attribution and an unofficial-project notice do not resolve those questions.

That the CLI works with the app is a technical observation, not a grant of rights. This document records what was reviewed. It is not legal advice, it does not say whether any of this use is permitted, and it does not claim legal clearance.

## Native host review, October 23, 2026

The Linux headless runtime uses the proprietary `libblip-jni.so` library
from Blip's official 1.2.6 archive. The installer verifies a pinned archive
checksum and extracts only that library. It does not redistribute the library
in this repository or install the desktop app and JVM.

REA 6.7.0 supplied Go build information and GNU objdump disassembly for the
native library. Java API and `javap` bytecode listings of the desktop jars,
including the desktop app's startup code, supplied matching hosting arguments,
the server address and user-agent message fields. The small C launcher in `native/host.c` was written
for this project using the exported C interface. No decompiled implementation
bodies, generated schema classes, or Blip binary assets are committed.

Running the native library directly remains use of Blip's proprietary engine
and undocumented interfaces. The uncertainties above still apply.

## macOS host review, October 24, 2026

The macOS runtime uses the intact BlipKit framework from the official Blip
1.2.3 archive, build 20260927200815. The installer pins its SHA-256 checksum
and verifies the framework signature integrity without modifying or re-signing
it. The desktop executable is not installed or launched. Framework resources
remain because the signature binds them. Apple system framework dependencies
remain part of the Mac runtime.

REA Go build inspection of the arm64 image identified the same native engine
entry point family as Linux. The existing C host loaded it and served RPC in
an isolated profile. No Blip binary, framework resources, or decompiled code
are committed. The proprietary-engine and interoperability uncertainties
above continue to apply.

## Name review, November 26, 2026

The project was renamed from Blip CLI to CLI for Blip, because Blip's terms
restrict use of its trademarks. The new name describes what the tool works
with. [Blip's terms of service](https://blip.net/terms-of-service) were read
again that day. They still carry the date January 18, 2025. The relevant text
says: "We own all rights to Blip, including trademarks and content. We grant
you a limited license to use Blip for its intended purpose. Please, do not use
Blip's trademarks without permission."

The terms do not mention reverse engineering, unofficial clients, or naming
rules. No brand or trademark guidelines were linked from the public Blip pages
reviewed. The new name still contains the word Blip, and no permission to use
it has been established. The command name, install paths, and the client name
and app id sent to Blip were not changed by this rename. The uncertainties
above still apply.
