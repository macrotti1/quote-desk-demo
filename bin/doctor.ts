// Entry point for `npm run doctor`. Works out where the API key would come from, the way bin/demo.ts
// does, and hands only that source to the doctor. The key's value never leaves this file's locals.
import type { KeySource } from "../src/contracts.ts";
import { createDoctorDeps, doctorMain, keySourceFrom } from "../src/cli/doctor.ts";
import { PATHS } from "../src/paths.ts";

// load.ts imports zod, so it loads late: before npm ci the doctor still runs and says what's missing.
let keySource: KeySource | null;
try {
  const { readDotEnv } = await import("../src/load.ts");
  keySource = keySourceFrom(readDotEnv(PATHS.dotEnv), process.env);
} catch {
  keySource = null;
}

process.exitCode = await doctorMain(process.argv.slice(2), await createDoctorDeps(process.stdout, keySource));
