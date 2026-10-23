#!/usr/bin/env bash
# Regenerates the Synthea base cohort (design section 2, "One shared world").
#
#   fixtures/synthea/generate.sh [out-dir]     out-dir defaults to fixtures/synthea
#
# Downloads the pinned Synthea jar once into $SYNTHEA_CACHE (default ~/.cache/riverbend/synthea),
# moving it there only once its SHA-256 matches (a bad download is deleted), runs it in a fresh temp directory with the flags below,
# then prunes the export with scripts/fixtures-synthea.ts into <out-dir>/base.ndjson.gz and
# <out-dir>/base.json. Prints the SHA-256 of the decompressed NDJSON; two runs print the same
# value. Needs a JDK 17+ and network on the first run; CI never runs it, it only rebuilds the
# world from the committed base.ndjson.gz.
set -euo pipefail
# Every tool the run calls sorts and formats in C, whatever the host's locale.
export LC_ALL=C

SYNTHEA_VERSION=v4.0.0
JAR_URL="https://github.com/synthetichealth/synthea/releases/download/${SYNTHEA_VERSION}/synthea-with-dependencies.jar"
JAR_SHA256=ed43c20ad40ba5c3bc724503a5af032715fe3c491620b766148e7c2361e6ecc1

repo=$(cd "$(dirname "$0")/../.." && pwd)

# Seed, clinician seed and living population from the design; the reference date (-r) and end
# date (-e) come from NOW in packages/env/clock.ts. Without -e, Synthea simulates up to the
# wall clock of the run, so the cohort would change with the day it is generated. Names
# without Synthea's numeric suffixes. Synthea formats dates in the JVM's zone, so the zone and
# locale are pinned too (JAVA_FLAGS), or the output would depend on the machine.
read -r reference_date end_date < <(node "$repo/scripts/fixtures-synthea.ts" --dates)
SYNTHEA_ARGS=(-s 20261023 -cs 7 -r "$reference_date" -e "$end_date" -p 60 --generate.append_numbers_to_person_names=false)
JAVA_FLAGS=(-Duser.timezone=America/New_York -Duser.language=en -Duser.country=US -Dfile.encoding=UTF-8)

out=$(cd "$repo" && mkdir -p "${1:-fixtures/synthea}" && cd "${1:-fixtures/synthea}" && pwd)
cache=${SYNTHEA_CACHE:-$HOME/.cache/riverbend/synthea}
jar="$cache/synthea-${SYNTHEA_VERSION}.jar"

sha() { shasum -a 256 "$1" | cut -d' ' -f1; }

# Checks a jar's digest; deletes it and fails when it does not match.
verify_jar() {
  local actual
  actual=$(sha "$1")
  if [ "$actual" != "$JAR_SHA256" ]; then
    rm -f "$1"
    echo "generate.sh: $1 had SHA-256 $actual, expected $JAR_SHA256; deleted it" >&2
    exit 1
  fi
}

if [ ! -f "$jar" ]; then
  mkdir -p "$cache"
  rm -f "$jar.part"
  curl -fsSL -o "$jar.part" "$JAR_URL" || { rm -f "$jar.part"; echo "generate.sh: download of $JAR_URL failed" >&2; exit 1; }
  verify_jar "$jar.part"
  mv "$jar.part" "$jar"
fi
# A cached jar is checked on every run too.
verify_jar "$jar"

command -v java >/dev/null || { echo "generate.sh: java not found (JDK 17+ needed)" >&2; exit 1; }

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
(cd "$work" && TZ=America/New_York java "${JAVA_FLAGS[@]}" -jar "$jar" "${SYNTHEA_ARGS[@]}" \
  --exporter.baseDirectory="$work/out" >"$work/synthea.log" 2>&1) || {
  tail -20 "$work/synthea.log" >&2
  exit 1
}

node "$repo/scripts/fixtures-synthea.ts" "$work/out/fhir" "$out" \
  --synthea "$SYNTHEA_VERSION" --jar-sha256 "$JAR_SHA256" -- "${SYNTHEA_ARGS[@]}" "${JAVA_FLAGS[@]}"
