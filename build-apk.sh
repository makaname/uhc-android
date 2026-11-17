#!/usr/bin/env bash
# Builds the debug APK: rebuilds the web bundle (via Gradle's prepareWeb task) and packages it.
# Output: android/app/build/outputs/apk/debug/app-debug.apk
set -euo pipefail
cd "$(dirname "$0")"

export JAVA_HOME="${JAVA_HOME:-$HOME/scoop/apps/temurin17-jdk/current}"
# Java on Windows makes a local socket file in the temp folder; a temp path with spaces or
# short names ("FOXBAR~1") breaks it ("Unable to establish loopback connection").
mkdir -p .jtmp
export JAVA_TOOL_OPTIONS="-Djdk.net.unixdomain.tmpdir=$(cygpath -w "$PWD/.jtmp" 2>/dev/null || echo "$PWD/.jtmp")"

cd android
./gradlew assembleDebug "$@"
echo
echo "APK: $(pwd)/app/build/outputs/apk/debug/app-debug.apk"
