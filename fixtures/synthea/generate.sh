#!/usr/bin/env bash
# Regenerates the Synthea base cohort (design section 2, "One shared world").
#
#   fixtures/synthea/generate.sh [out-dir]     out-dir defaults to fixtures/synthea
#
# Downloads the pinned Synthea jar once into $SYNTHEA_CACHE (default ~/.cache/riverbend/synthea),
# refuses it unless its SHA-256 matches, runs it in a fresh temp directory with the flags below,
# then prunes the export with scripts/fixtures-synthea.ts into <out-dir>/base.ndjson.gz and
# <out-dir>/base.json. Prints the SHA-256 of the decompressed NDJSON; two runs print the same
# value. Needs a JDK 17+ and network on the first run; CI never runs it, it only rebuilds the
# world from the committed base.ndjson.gz.
set -euo pipefail

SYNTHEA_VERSION=v4.0.0
JAR_URL="https://github.com/synthetichealth/synthea/releases/download/${SYNTHEA_VERSION}/synthea-with-dependencies.jar"
JAR_SHA256=ed43c20ad40ba5c3bc724503a5af032715fe3c491620b766148e7c2361e6ecc1

# Seed, clinician seed, reference date and living population from the design. Names without
# Synthea's numeric suffixes. Synthea formats dates in the JVM's zone, so the zone and locale
# are pinned too (JAVA_FLAGS), or the output would depend on the machine.
SYNTHEA_ARGS=(-s 20261023 -cs 7 -r 20261023 -p 60 --generate.append_numbers_to_person_names=false)
JAVA_FLAGS=(-Duser.timezone=America/New_York -Duser.language=en -Duser.country=US -Dfile.encoding=UTF-8)

repo=$(cd "$(dirname "$0")/../.." && pwd)
out=$(cd "$repo" && mkdir -p "${1:-fixtures/synthea}" && cd "${1:-fixtures/synthea}" && pwd)
cache=${SYNTHEA_CACHE:-$HOME/.cache/riverbend/synthea}
jar="$cache/synthea-${SYNTHEA_VERSION}.jar"

command -v java >/dev/null || { echo "generate.sh: java not found (JDK 17+ needed)" >&2; exit 1; }

sha() { shasum -a 256 "$1" | cut -d' ' -f1; }

if [ ! -f "$jar" ]; then
  mkdir -p "$cache"
  curl -fsSL -o "$jar.part" "$JAR_URL"
  mv "$jar.part" "$jar"
fi
actual=$(sha "$jar")
if [ "$actual" != "$JAR_SHA256" ]; then
  echo "generate.sh: $jar has SHA-256 $actual, expected $JAR_SHA256" >&2
  exit 1
fi

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
(cd "$work" && TZ=America/New_York java "${JAVA_FLAGS[@]}" -jar "$jar" "${SYNTHEA_ARGS[@]}" \
  --exporter.baseDirectory="$work/out" >"$work/synthea.log" 2>&1) || {
  tail -20 "$work/synthea.log" >&2
  exit 1
}

node "$repo/scripts/fixtures-synthea.ts" "$work/out/fhir" "$out" \
  --synthea "$SYNTHEA_VERSION" --jar-sha256 "$JAR_SHA256" -- "${SYNTHEA_ARGS[@]}" "${JAVA_FLAGS[@]}"
