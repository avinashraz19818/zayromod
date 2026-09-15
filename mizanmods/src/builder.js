import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { ROOT } from './config.js';
import { escapeHtml, validate } from './validation.js';
export function preflight(c) {
  const checks = [];
  const check = (name, fn) => { try { fn(); checks.push({ name, ok: true }); } catch { checks.push({ name, ok: false }); } };
  check('Java 17 or newer', () => {
    const result = spawnSync('java', ['-version'], { encoding: 'utf8', timeout: 5000 });
    const major = Number((String(result.stderr || result.stdout).match(/version \"(\d+)/) || [])[1]);
    if (result.error || result.status !== 0 || major < 17 || !major) throw Error('Java 17+ required');
  });
  check('Android platform 35', () => fs.accessSync(path.join(c.sdk, 'platforms/android-35/android.jar')));
  for (const tool of ['zipalign', 'apksigner', 'aapt']) check(tool, () => fs.accessSync(path.join(c.sdk, 'build-tools', c.tools, tool), fs.constants.X_OK));
  check('Private signing keystore', () => { if (!path.isAbsolute(c.keystore)) throw Error(); fs.accessSync(c.keystore); });
  check('Signing passwords', () => { if (!process.env.KEYSTORE_PASSWORD || !process.env.KEY_PASSWORD) throw Error(); });
  return checks;
}
export function generateProject(project, raw) {
  const c = validate(raw);
  fs.cpSync(path.join(ROOT, 'android-template'), project, { recursive: true, filter: p => !['build', '.gradle', 'local.properties'].includes(path.basename(p)) });
  fs.chmodSync(path.join(project, 'gradlew'), 0o755);
  const gradle = path.join(project, 'app/build.gradle');
  let text = fs.readFileSync(gradle, 'utf8');
  for (const [key, value] of Object.entries({ PACKAGE: c.packageName, VERSION_CODE: c.versionCode, VERSION_NAME: c.versionName })) text = text.replaceAll(`__${key}__`, String(value));
  fs.writeFileSync(gradle, text);
  fs.writeFileSync(path.join(project, 'app/src/main/res/values/strings.xml'), `<resources><string name="app_name" translatable="false">${escapeHtml(c.appName)}</string></resources>`);
  const assets = path.join(project, 'app/src/main/assets');
  for (const name of ['popup.html', 'popup.css', 'popup.js', 'mark.svg']) fs.copyFileSync(path.join(ROOT, 'public', name), path.join(assets, name));
  const htmlFile = path.join(assets, 'popup.html');
  const html = fs.readFileSync(htmlFile, 'utf8').replaceAll('__APP_NAME__', escapeHtml(c.appName)).replaceAll('__WELCOME__', escapeHtml(c.welcome));
  fs.writeFileSync(htmlFile, html);
  fs.appendFileSync(path.join(assets, 'popup.css'), `\n:root { --accent: ${c.accent}; }\n`);
}
export function build(c, job, log) {
  const workspace = path.join(c.data, 'work', job.id), artifact = path.join(c.data, 'artifacts', job.id);
  const run = (bin, args, cwd = workspace) => {
    try { return execFileSync(bin, args, { cwd, env: { ...process.env, ANDROID_HOME: c.sdk, ANDROID_SDK_ROOT: c.sdk, GRADLE_USER_HOME: path.join(c.data, 'gradle') }, timeout: c.timeout, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (e) {
      let detail = String(e.stderr || e.stdout || e.message).slice(-6000);
      for (const secret of [process.env.KEYSTORE_PASSWORD, process.env.KEY_PASSWORD, c.token]) if (secret) detail = detail.replaceAll(secret, '[redacted]');
      throw new Error(`${path.basename(bin)} failed: ${detail}`);
    }
  };
  try {
    log('Checking Android toolchain and signing configuration', 5);
    const missing = preflight(c).filter(x => !x.ok).map(x => x.name);
    if (missing.length) throw Error(`Setup required: ${missing.join(', ')}. Run npm run doctor.`);
    log('Generating isolated Android project and popup assets', 15);
    generateProject(workspace, job.config);
    log('Compiling release with Gradle', 30);
    run('./gradlew', [':app:assembleRelease', '--no-daemon', '--console=plain', '--max-workers=2']);
    const unsigned = path.join(workspace, 'app/build/outputs/apk/release/app-release-unsigned.apk');
    if (!fs.existsSync(unsigned)) throw Error('Gradle did not produce the expected release APK');
    fs.mkdirSync(artifact, { recursive: true, mode: 0o700 });
    const aligned = path.join(artifact, 'aligned.apk'), signed = path.join(artifact, 'MizanMods.apk');
    const tool = name => path.join(c.sdk, 'build-tools', c.tools, name);
    log('Aligning and signing release', 75);
    run(tool('zipalign'), ['-f', '4', unsigned, aligned]);
    run(tool('apksigner'), ['sign', '--ks', c.keystore, '--ks-key-alias', c.alias, '--ks-pass', 'env:KEYSTORE_PASSWORD', '--key-pass', 'env:KEY_PASSWORD', '--v4-signing-enabled', 'false', '--out', signed, aligned]);
    log('Verifying signature, alignment and package metadata', 90);
    run(tool('apksigner'), ['verify', '--verbose', signed]);
    run(tool('zipalign'), ['-c', '4', signed]);
    const metadata = run(tool('aapt'), ['dump', 'badging', signed]);
    if (!metadata.includes(`package: name='${job.config.packageName}'`) || !metadata.includes(`versionCode='${job.config.versionCode}'`) || !metadata.includes(`versionName='${job.config.versionName}'`) || metadata.includes('application-debuggable')) throw Error('Release metadata verification failed');
    fs.unlinkSync(aligned);
    const bytes = fs.readFileSync(signed);
    return { sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length };
  } catch (e) { fs.rmSync(artifact, { recursive: true, force: true }); throw e; }
  finally { fs.rmSync(workspace, { recursive: true, force: true }); }
}
