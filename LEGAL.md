# Blip rights and source review

Reviewed on October 17, 2026 against [Blip's official terms of service](https://blip.net/terms-of-service), dated January 18, 2025.

## Blip's rights

[Blip](https://blip.net/) is provided by Blip Studio Inc. Its terms reserve rights to Blip, including its trademarks and content. They grant a limited license for Blip's intended purpose and restrict trademark use without permission. They require a Business plan for commercial activities.

This project is independent and unofficial. Blip Studio Inc. has not affiliated with or endorsed it. The project's [MIT license](LICENSE) covers this repository's code and documentation. It does not grant rights to Blip's proprietary app, services, trademarks, or content. Download the app from Blip and comply with its terms separately.

## What the source review found

The tracked source at the time of review consists of a Node.js CLI, a small JavaScript DRPC/protobuf implementation, a shell installer, and documentation. The current source and the initial DRPC implementation were inspected. No Blip binaries, jars, logos, generated schema classes, or decompiled method bodies were found among those files. The installer retrieves the official installer from Blip's server at runtime rather than bundling the app.

The README and source identify Blip 1.2.6 as the reverse-engineering target. The CLI contains RPC method names, event names, field numbers, enum values, and an app-specific device identifier path obtained from that interface. A sentence accompanying a newly generated device identifier appeared to reproduce the app's explanatory text. It was removed, leaving a UUID followed by a newline. The reader already consumes only the first 36 characters.

The JavaScript DRPC helper names `storj.io/drpc` v0.0.32 as its protocol reference. It uses Node's built-in modules and includes no vendored Go source. The available git history does not independently prove how every line was authored. Source inspection alone cannot establish complete provenance or legal permission.

## Remaining uncertainty

The reviewed Blip terms do not expressly authorize this reverse-engineered client or the use of its undocumented RPC interface. No permission from Blip Studio Inc. for this project or its use of the Blip name has been established. Attribution and an unofficial-project notice do not resolve those questions.

Compatibility with the app is a technical observation, not a grant of rights. Whether reverse engineering, interoperability, publication, or descriptive trademark use is permitted depends on the applicable law, agreements, and facts. Permission or a qualified legal review is needed to settle those questions. This document records the review's limits and does not claim legal clearance.

## Native host review, October 23, 2026

The Linux headless runtime uses the proprietary `libblip-jni.so` library
from Blip's official 1.2.6 archive. The installer verifies a pinned archive
checksum and extracts only that library. It does not redistribute the library
in this repository or install the desktop app and JVM.

REA 6.7.0 supplied Go build information and GNU objdump disassembly for the
native library. Java API inspection supplied matching hosting arguments and
user-agent message fields. The small C launcher in `native/host.c` was written
for this project using the exported C interface. No decompiled implementation
bodies, generated schema classes, or Blip binary assets are committed.

Running the native library directly remains use of Blip's proprietary engine
and undocumented interfaces. The uncertainties above still apply.

## macOS host review, October 24, 2026

The macOS runtime uses the intact BlipKit framework from the official Blip
1.2.3 archive, build 20260927200815. The installer pins its SHA-256 checksum
and verifies the vendor framework signature without modifying or re-signing
it. The desktop executable is not installed or launched. Framework resources
remain because the signature binds them. Apple system framework dependencies
remain part of the Mac runtime.

REA Go build inspection of the arm64 image identified the same native engine
entry point family as Linux. The existing C host loaded it and served RPC in
an isolated profile. No Blip binary, framework resources, or decompiled code
are committed. The proprietary-engine and interoperability uncertainties
above continue to apply.
