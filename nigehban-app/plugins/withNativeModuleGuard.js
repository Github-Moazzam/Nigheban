const fs = require('fs');
const path = require('path');
const { withDangerousMod } = require('@expo/config-plugins');

/**
 * Expo Config Plugin: withNativeModuleGuard
 *
 * Fail the build when a local Expo module in `modules/` declares Android native
 * code that is not actually present to compile.
 *
 * This exists because of one silent failure that cost the emergency alarm its
 * entire native half. `modules/nigehban-alarm/` declares
 * `com.nigehban.alarm.NigehbanAlarmModule`, and the Kotlin behind it was
 * written on 26 Aug 2026 -- but the repo's root .gitignore carried an
 * unanchored `android/`, which matches a directory of that name at *any* depth.
 * So `modules/nigehban-alarm/android/` never entered git, and therefore never
 * entered the tarball EAS builds from. Three mechanisms then each declined to
 * complain, for individually good reasons:
 *
 *   - autolinking skips a module whose native directory is absent,
 *   - Gradle had nothing to compile, and so compiled nothing,
 *   - `requireOptionalNativeModule` returns null rather than throwing -- by
 *     design, so the app does not die on a platform where the module is
 *     legitimately missing.
 *
 * Every build was green and every APK shipped without the feature, for weeks,
 * while the development plan recorded it as "compiles on the next EAS build".
 * This turns that specific silence into a build failure.
 *
 * It runs inside a dangerous mod so it fires during `expo prebuild` -- which is
 * what EAS runs, against the *uploaded* files. That is the only place the
 * mismatch was ever observable: the same check on the authoring machine would
 * have passed, because there the sources were sitting right there. `expo start`
 * is deliberately left alone, so a missing native module never blocks JS work.
 */

/** Where an Expo module's Android sources are allowed to live. */
const SOURCE_ROOTS = ['src/main/java', 'src/main/kotlin'];

/** Every path a declared class could reasonably be defined in. */
function sourceCandidates(className) {
  const rel = className.split('.').join('/');
  return SOURCE_ROOTS.flatMap((root) => [`${root}/${rel}.kt`, `${root}/${rel}.java`]);
}

function auditModule(modulesDir, name) {
  const moduleDir = path.join(modulesDir, name);
  const configPath = path.join(moduleDir, 'expo-module.config.json');
  // Not every directory under modules/ is an Expo module; the ones that are
  // announce themselves with this file.
  if (!fs.existsSync(configPath)) return [];

  let moduleConfig;
  try {
    moduleConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (e) {
    return [`${name}: expo-module.config.json is not valid JSON -- ${e.message}`];
  }

  const declaredClasses = moduleConfig?.android?.modules ?? [];
  const declaresAndroid = declaredClasses.length > 0
    || (moduleConfig?.platforms ?? []).includes('android');
  if (!declaresAndroid) return [];

  const androidDir = path.join(moduleDir, 'android');
  if (!fs.existsSync(androidDir)) {
    return [
      `${name}: declares Android native code, but modules/${name}/android/ is `
      + 'not in this build. Nothing will be compiled, and at runtime '
      + 'requireOptionalNativeModule() will return null.',
    ];
  }

  const problems = [];
  // A native directory with no Gradle file is autolinked and then ignored,
  // which looks identical to success right up until the module is missing.
  const hasGradle = ['build.gradle', 'build.gradle.kts']
    .some((f) => fs.existsSync(path.join(androidDir, f)));
  if (!hasGradle) {
    problems.push(`${name}: modules/${name}/android/ has no build.gradle -- Gradle will not compile it.`);
  }

  for (const className of declaredClasses) {
    const found = sourceCandidates(className)
      .some((rel) => fs.existsSync(path.join(androidDir, rel)));
    if (!found) {
      problems.push(
        `${name}: declares "${className}" but no matching .kt or .java source exists `
        + `under modules/${name}/android/{${SOURCE_ROOTS.join(',')}}/.`
      );
    }
  }
  return problems;
}

/** Exported for tests; the plugin below is the only production caller. */
function auditLocalModules(projectRoot) {
  const modulesDir = path.join(projectRoot, 'modules');
  if (!fs.existsSync(modulesDir)) return { checked: 0, problems: [] };

  const names = fs.readdirSync(modulesDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

  return {
    checked: names.length,
    problems: names.flatMap((n) => auditModule(modulesDir, n)),
  };
}

function withNativeModuleGuard(config) {
  return withDangerousMod(config, ['android', (cfg) => {
    const { checked, problems } = auditLocalModules(cfg.modRequest.projectRoot);

    if (problems.length) {
      throw new Error(
        'withNativeModuleGuard: local Expo module(s) declare Android native code '
        + 'that is not present in this build.\n\n'
        + problems.map((p) => `  - ${p}`).join('\n')
        + '\n\nThis is the exact failure that shipped an alarm-less APK for weeks. '
        + 'Either restore the native sources, or drop the Android declaration from '
        + "that module's expo-module.config.json so the gap is explicit rather than "
        + 'silent.\n\nIf the sources exist on your machine but not here, check '
        + '.gitignore: an unanchored `android/` pattern matches at any depth and '
        + 'will keep them out of both git and the EAS upload.\n'
      );
    }

    console.log(
      `withNativeModuleGuard: ${checked} local module(s) checked, native sources present.`
    );
    return cfg;
  }]);
}

module.exports = withNativeModuleGuard;
module.exports.auditLocalModules = auditLocalModules;
