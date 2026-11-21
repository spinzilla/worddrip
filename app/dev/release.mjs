// WordDrip 正式发版工具。密钥只在内存中读取，并仅传给当前构建子进程。
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoDir = path.resolve(appDir, '..');
const tauriDir = path.join(appDir, 'src-tauri');
const androidDir = path.join(tauriDir, 'gen', 'android');
const cargoTarget = 'E:\\rust\\target';
const gradleHome = 'E:\\android\\gradle-home';
const outputRoot = 'D:\\tmp\\es-release';
const androidTempRoot = 'D:\\tmp\\es-android';
const releaseBaseUrl = 'https://vocab.uestceee.art/worddrip-updates';
const releaseDir = process.env.WORDDRIP_RELEASE_DIR || path.join(process.env.USERPROFILE || process.env.HOME, '.worddrip-release');
const isWindows = process.platform === 'win32';
const cli = isWindows ? 'npx.cmd' : 'npx';
const timeout = 600_000;

function fail(message) {
  throw new Error(message);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function semver(value) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(value || '');
  if (!match) fail(`版本号必须是 x.y.z 格式，例如 0.9.3：${value}`);
  return match.slice(1).map(Number);
}

export function androidVersionCode(version) {
  const [major, minor, patch] = semver(version);
  const code = major * 1_000_000 + minor * 1_000 + patch;
  if (!Number.isSafeInteger(code) || code > 2_147_483_647) fail(`版本号 ${version} 算出的 Android versionCode 超出范围`);
  return code;
}

function updateCargoVersion(version) {
  const file = path.join(tauriDir, 'Cargo.toml');
  const text = fs.readFileSync(file, 'utf8');
  const pattern = /(^\[package\][\s\S]*?^version\s*=\s*)"([^"]+)"/m;
  const match = pattern.exec(text);
  if (!match) fail('Cargo.toml 的 [package] version 未找到');
  if (match[2] === version) return;
  fs.writeFileSync(file, text.replace(pattern, `$1"${version}"`), 'utf8');
}

function updateCargoLockVersion(version) {
  const file = path.join(tauriDir, 'Cargo.lock');
  if (!fs.existsSync(file)) return;
  const cargoText = fs.readFileSync(path.join(tauriDir, 'Cargo.toml'), 'utf8');
  const packageName = /^\[package\][\s\S]*?^name\s*=\s*"([^"]+)"/m.exec(cargoText)?.[1];
  if (!packageName) fail('Cargo.toml 的 [package] name 未找到，无法同步 Cargo.lock');
  const lockText = fs.readFileSync(file, 'utf8');
  const blocks = lockText.split(/(?=^\[\[package\]\]\s*$)/m);
  const matches = blocks.map((block, index) => /^name\s*=\s*"([^"]+)"/m.exec(block)?.[1] === packageName ? index : -1).filter((index) => index !== -1);
  if (matches.length !== 1) fail(`Cargo.lock 中 ${packageName} 包应恰好出现一次，实际 ${matches.length} 次`);
  const index = matches[0];
  const oldVersion = /^version\s*=\s*"[^"]+"/m;
  if (!oldVersion.test(blocks[index])) fail(`Cargo.lock 中 ${packageName} 包的 version 未找到`);
  blocks[index] = blocks[index].replace(oldVersion, `version = "${version}"`);
  fs.writeFileSync(file, blocks.join(''), 'utf8');
}

function bump(version) {
  semver(version);
  const tauriFile = path.join(tauriDir, 'tauri.conf.json');
  const packageFile = path.join(appDir, 'package.json');
  const lockFile = path.join(appDir, 'package-lock.json');
  const tauriConfig = readJson(tauriFile);
  const packageConfig = readJson(packageFile);
  tauriConfig.version = version;
  packageConfig.version = version;
  writeJson(tauriFile, tauriConfig);
  writeJson(packageFile, packageConfig);
  if (fs.existsSync(lockFile)) {
    const lock = readJson(lockFile);
    lock.version = version;
    if (lock.packages?.['']) lock.packages[''].version = version;
    writeJson(lockFile, lock);
  }
  updateCargoVersion(version);
  updateCargoLockVersion(version);
  console.log(`版本已同步为 ${version}（Android versionCode ${androidVersionCode(version)}）`);
}

function configuredVersions() {
  const tauri = readJson(path.join(tauriDir, 'tauri.conf.json')).version;
  const packageVersion = readJson(path.join(appDir, 'package.json')).version;
  const cargoText = fs.readFileSync(path.join(tauriDir, 'Cargo.toml'), 'utf8');
  const cargo = /^\[package\][\s\S]*?^version\s*=\s*"([^"]+)"/m.exec(cargoText)?.[1];
  return { tauri, packageVersion, cargo };
}

function getReleaseDir() {
  return releaseDir;
}

function refreshUserToolchainEnvironment(env) {
  if (!isWindows) return;
  // 进程可能没继承用户后来配置的工具链，只读注册表补齐。
  try {
    const text = execFileSync('reg', ['query', 'HKCU\\Environment'], { encoding: 'utf8' });
    for (const line of text.split(/\r?\n/)) {
      const match = line.match(/^\s+(\S+)\s+REG_(?:EXPAND_)?SZ\s+(.*)$/);
      if (!match) continue;
      const [, key, raw] = match;
      if (['JAVA_HOME', 'ANDROID_HOME', 'NDK_HOME', 'RUSTUP_HOME', 'CARGO_HOME'].includes(key)) env[key] = raw.replace(/%([^%]+)%/g, (_, name) => env[name] || `%${name}%`);
      if (key === 'PATH') {
        const userPath = raw.replace(/%([^%]+)%/g, (_, name) => env[name] || `%${name}%`);
        env.PATH = [...new Set(`${userPath};${env.PATH || ''}`.split(';').filter(Boolean))].join(';');
      }
    }
  } catch { /* 当前环境已含工具链，或注册表不可读；后续构建会给出明确错误 */ }
}

const childEnv = { ...process.env, CARGO_TARGET_DIR: cargoTarget, GRADLE_USER_HOME: gradleHome, WORDDRIP_RELEASE_DIR: getReleaseDir() };
delete childEnv.CFLAGS;
delete childEnv.CXXFLAGS;
refreshUserToolchainEnvironment(childEnv);

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: appDir,
    env: childEnv,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    shell: isWindows,
    timeout,
    ...options,
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) fail(`运行 ${command} 失败：${result.error.message}`);
  if (result.status !== 0) fail(`${command} 退出码 ${result.status ?? '未知'}`);
  return result;
}

function validateVersionSet() {
  const versions = configuredVersions();
  if (!versions.tauri || versions.tauri !== versions.packageVersion || versions.tauri !== versions.cargo) {
    fail(`三处版本号不一致：tauri.conf.json=${versions.tauri}，package.json=${versions.packageVersion}，Cargo.toml=${versions.cargo}。请先运行 bump。`);
  }
  semver(versions.tauri);
  return versions.tauri;
}

function ensureClean(allowDirty) {
  if (allowDirty) return;
  const result = spawnSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: repoDir, encoding: 'utf8', shell: isWindows });
  if (result.status !== 0) fail('无法检查 git 工作区状态');
  if (result.stdout.trim()) fail('工作区有未提交或未跟踪的改动；如确认这是测试构建，请加 --allow-dirty。');
}

function checkRequiredReleaseFiles() {
  const needed = ['android-release.jks', 'keystore.properties', 'tauri-updater.key', 'tauri-updater.password'];
  const missing = needed.filter((name) => !fs.existsSync(path.join(releaseDir, name)));
  if (missing.length) fail(`签名材料不完整（缺少文件：${missing.join('、')}），请检查 WORDDRIP_RELEASE_DIR。未读取或输出密钥内容。`);
}

function withUpdaterSigningEnv() {
  checkRequiredReleaseFiles();
  childEnv.TAURI_SIGNING_PRIVATE_KEY = fs.readFileSync(path.join(releaseDir, 'tauri-updater.key'), 'utf8').replace(/[\r\n]+$/, '');
  childEnv.TAURI_SIGNING_PRIVATE_KEY_PASSWORD = fs.readFileSync(path.join(releaseDir, 'tauri-updater.password'), 'utf8').replace(/[\r\n]+$/, '');
}

function findFiles(root, predicate, found = []) {
  if (!fs.existsSync(root)) return found;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) findFiles(full, predicate, found);
    else if (entry.isFile() && predicate(full)) found.push(full);
  }
  return found;
}

function prepareTcpPipePatch() {
  const sourceZip = path.join(childEnv.JAVA_HOME, 'lib', 'src.zip');
  if (!fs.existsSync(sourceZip)) return '';
  const root = path.join(androidTempRoot, 'jdk-tcp-pipe');
  const source = path.join(root, 'src', 'java.base', 'sun', 'nio', 'ch', 'PipeImpl.java');
  const classes = path.join(root, 'classes');
  fs.mkdirSync(path.dirname(source), { recursive: true });
  fs.mkdirSync(classes, { recursive: true });
  if (!fs.existsSync(source)) {
    execFileSync('tar', ['-xf', sourceZip, '-C', path.join(root, 'src'), 'java.base/sun/nio/ch/PipeImpl.java'], { stdio: 'inherit' });
  }
  const original = fs.readFileSync(source, 'utf8');
  const patched = original.replace('new Initializer(sp, preferAfUnix)', 'new Initializer(sp, false)');
  if (patched === original && !original.includes('new Initializer(sp, false)')) fail('JDK PipeImpl 源码版本不匹配，无法为 Gradle 启用 TCP 回退');
  fs.writeFileSync(source, patched);
  const javac = path.join(childEnv.JAVA_HOME, 'bin', isWindows ? 'javac.exe' : 'javac');
  run(javac, ['--patch-module', `java.base=${path.join(root, 'src')}`, '-d', classes, source]);
  return classes;
}

function newest(files) {
  return files.map((file) => ({ file, mtime: fs.statSync(file).mtimeMs })).sort((a, b) => b.mtime - a.mtime)[0]?.file;
}

function buildDesktop(version) {
  withUpdaterSigningEnv();
  run(cli, ['tauri', 'build', '--bundles', 'nsis']);
  const bundleDir = path.join(cargoTarget, 'release', 'bundle', 'nsis');
  const versionSuffix = `_${version}_x64-setup.exe`.toLowerCase();
  const installer = newest(findFiles(bundleDir, (file) => path.basename(file).toLowerCase().endsWith(versionSuffix)));
  if (!installer) fail(`Tauri 构建完成，但未找到版本 ${version} 的 NSIS 安装包：${bundleDir}`);
  const signature = `${installer}.sig`;
  if (!fs.existsSync(signature) || fs.statSync(signature).size === 0) fail('NSIS 安装包的更新签名 .sig 未生成或为空');
  return { installer, signature };
}

function androidBuildToolsAapt2() {
  const sdkDir = childEnv.ANDROID_HOME || childEnv.ANDROID_SDK_ROOT;
  if (!sdkDir) fail('缺少 Android SDK 路径，无法校验 release APK 版本');
  const buildToolsDir = path.join(sdkDir, 'build-tools');
  const versions = fs.existsSync(buildToolsDir)
    ? fs.readdirSync(buildToolsDir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
    : [];
  const executable = isWindows ? 'aapt2.exe' : 'aapt2';
  const aapt2 = versions.map((version) => path.join(buildToolsDir, version, executable)).find((file) => fs.existsSync(file));
  if (!aapt2) fail(`Android SDK build-tools 中找不到 ${executable}，无法校验 release APK`);
  return aapt2;
}

function apkMatchesVersion(apk, version, aapt2) {
  const result = spawnSync(aapt2, ['dump', 'badging', apk], {
    cwd: appDir, env: childEnv, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, shell: isWindows, timeout,
  });
  if (result.error || result.status !== 0) fail(`无法读取 APK 版本信息：${result.error?.message || result.stderr || `退出码 ${result.status}`}`);
  const packageLine = /^package:.*$/m.exec(result.stdout)?.[0] || '';
  const packageName = /\bname='([^']+)'/.exec(packageLine)?.[1];
  const versionName = /\bversionName='([^']+)'/.exec(packageLine)?.[1];
  const versionCode = /\bversionCode='([^']+)'/.exec(packageLine)?.[1];
  if (packageName !== 'com.englishstudio.app' || versionName !== version || versionCode !== String(androidVersionCode(version))) return false;
  return true;
}

function buildAndroid(version) {
  for (const key of ['JAVA_HOME', 'ANDROID_HOME', 'NDK_HOME']) {
    if (!childEnv[key]) fail(`缺少 ${key}，请先按任务卡配置安卓工具链`);
  }
  // Tauri Android build 默认就是 release；--debug 才会切到 debug。
  const args = ['tauri', 'android', 'build', '--target', 'aarch64', '--apk'];
  let result = spawnSync(cli, args, {
    cwd: appDir, env: childEnv, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    shell: isWindows, timeout, stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) fail(`安卓构建启动失败：${result.error.message}`);
  if (result.status !== 0) {
    const output = `${result.stdout || ''}\n${result.stderr || ''}`;
    if (!output.includes('Creation symbolic link is not allowed')) fail(`安卓 release 构建退出码 ${result.status ?? '未知'}`);
    const abiDir = path.join(androidDir, 'app', 'src', 'main', 'jniLibs', 'arm64-v8a');
    fs.mkdirSync(abiDir, { recursive: true });
    const nativeLib = path.join(cargoTarget, 'aarch64-linux-android', 'release', 'liblinguaclip_lib.so');
    if (!fs.existsSync(nativeLib)) fail(`安卓 Rust release 库不存在：${nativeLib}`);
    fs.copyFileSync(nativeLib, path.join(abiDir, 'liblinguaclip_lib.so'));
    const tcpPatch = prepareTcpPipePatch();
    if (tcpPatch) childEnv.JDK_JAVA_OPTIONS = [`--patch-module=java.base=${tcpPatch}`, childEnv.JDK_JAVA_OPTIONS].filter(Boolean).join(' ');
    result = spawnSync(path.join(androidDir, isWindows ? 'gradlew.bat' : 'gradlew'), [
      '--no-daemon', '-p', androidDir, ':app:assembleArm64Release', '-x', ':app:rustBuildArm64Release',
      '-PabiList=arm64-v8a', '-ParchList=arm64', '-PtargetList=aarch64', '-Pkotlin.incremental=false', '--console=plain',
    ], { cwd: appDir, env: childEnv, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, shell: isWindows, timeout });
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    if (result.error) fail(`Gradle 安卓 release 构建失败：${result.error.message}`);
    if (result.status !== 0) fail(`Gradle 安卓 release 构建退出码 ${result.status ?? '未知'}`);
  }
  const apkRoot = path.join(androidDir, 'app', 'build', 'outputs', 'apk', 'arm64', 'release');
  const aapt2 = androidBuildToolsAapt2();
  const candidates = findFiles(apkRoot, (file) => /\.apk$/i.test(file)).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  const apk = candidates.find((file) => apkMatchesVersion(file, version, aapt2));
  if (!apk) fail(`安卓构建完成，但未找到包名、versionName 和 versionCode 均匹配 ${version} 的 arm64 release APK：${apkRoot}`);
  return apk;
}

function makeManifests(version, notes, installer, signature, apk) {
  const outputDir = path.join(outputRoot, version);
  fs.mkdirSync(outputDir, { recursive: true });
  const installerName = `WordDrip_${version}_x64-setup.exe`;
  const apkName = `worddrip-${version}.apk`;
  const installerOut = path.join(outputDir, installerName);
  const signatureOut = `${installerOut}.sig`;
  const apkOut = path.join(outputDir, apkName);
  fs.copyFileSync(installer, installerOut);
  fs.copyFileSync(signature, signatureOut);
  fs.copyFileSync(apk, apkOut);
  const pubDate = new Date().toISOString();
  const baseUrl = `${releaseBaseUrl}/${version}`;
  writeJson(path.join(outputDir, 'latest.json'), {
    version,
    notes,
    pub_date: pubDate,
    platforms: {
      'windows-x86_64': {
        url: `${baseUrl}/${installerName}`,
        signature: fs.readFileSync(signatureOut, 'utf8').trim(),
      },
    },
  });
  const apkBuffer = fs.readFileSync(apkOut);
  writeJson(path.join(outputDir, 'android.json'), {
    version,
    versionCode: androidVersionCode(version),
    url: `${baseUrl}/${apkName}`,
    sha256: createHash('sha256').update(apkBuffer).digest('hex'),
    size: apkBuffer.length,
    notes,
    pub_date: pubDate,
  });
  console.log(`发版产物：${outputDir}`);
  console.log(`安装包 ${installerName}（${fs.statSync(installerOut).size} 字节）`);
  console.log(`安卓包 ${apkName}（${apkBuffer.length} 字节）`);
}

function parseBuildArgs(args) {
  let allowDirty = false;
  let notes = '';
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--allow-dirty') allowDirty = true;
    else if (args[i] === '--notes') {
      if (i + 1 >= args.length) fail('--notes 后面需要跟更新说明');
      notes = args[++i];
    } else fail(`未知 build 参数：${args[i]}`);
  }
  return { allowDirty, notes };
}

function build(args) {
  const { allowDirty, notes } = parseBuildArgs(args);
  ensureClean(allowDirty);
  const version = validateVersionSet();
  checkRequiredReleaseFiles();
  const desktop = buildDesktop(version);
  const apk = buildAndroid(version);
  makeManifests(version, notes, desktop.installer, desktop.signature, apk);
}

function quote(value) {
  return `"${String(value).replaceAll('"', '\\"')}"`;
}

function upload(version, dryRun) {
  semver(version);
  const dir = path.join(outputRoot, version);
  const packages = [
    `WordDrip_${version}_x64-setup.exe`,
    `WordDrip_${version}_x64-setup.exe.sig`,
    `worddrip-${version}.apk`,
  ];
  const manifests = ['latest.json', 'android.json'];
  for (const name of [...packages, ...manifests]) {
    if (!fs.existsSync(path.join(dir, name))) fail(`缺少待上传文件：${path.join(dir, name)}`);
  }
  // 安装包放 <版本>/ 子目录；应用读的是根目录的 latest.json / android.json（tauri.conf.json 的 endpoints、utils/update.ts），
  // 所以两个清单最后才传：先传临时名，留一份存档到 <版本>/，再 mv 成正式名，避免应用读到一半的清单。
  const updatesRoot = '/var/www/worddrip-updates';
  const remoteDir = `${updatesRoot}/${version}`;
  if (dryRun) {
    for (const name of packages) console.log(`上传 ${name} → tencent:${remoteDir}/（大于 ${chunkSize / 1024 / 1024} MB 的切块传，传完对 sha256）`);
    for (const name of manifests) console.log(`上传 ${name} → tencent:${updatesRoot}/${name}.tmp`);
    console.log(`ssh tencent ${quote(publishCommand(updatesRoot, version))}`);
    return;
  }
  remote(`mkdir -p ${remoteDir}`);
  for (const name of packages) uploadChecked(path.join(dir, name), remoteDir, name);
  for (const name of manifests) scpWithRetry(path.join(dir, name), `${updatesRoot}/${name}.tmp`);
  remote(publishCommand(updatesRoot, version));
  console.log(`已发布 ${version}：${releaseBaseUrl}/latest.json、${releaseBaseUrl}/android.json`);
}

// 本机到服务器的线路传大文件会断（0.11.0、0.11.3 的 APK 都在十几 MB 处卡死），所以：
// 大文件切成 4 MB 小块逐块传，每块单独超时、失败重试；服务器上拼好后对 sha256，一致才换上正式名。
// 服务器上已有同 sha256 的文件就跳过，发版中途失败后可以直接重跑 upload。
const chunkSize = 4 * 1024 * 1024;
const transferTimeout = 180_000;
const transferRetries = 4;

function publishCommand(updatesRoot, version) {
  return `cd ${updatesRoot} && cp latest.json.tmp ${version}/latest.json && cp android.json.tmp ${version}/android.json && mv latest.json.tmp latest.json && mv android.json.tmp android.json && chmod 644 latest.json android.json`;
}

function runTransfer(command, args, { allowFail = false, capture = false, timeoutMs = transferTimeout } = {}) {
  // ssh/scp 是真正的 exe，不走 shell：Windows 上走 cmd 时，远程命令里的 && 会被本机 cmd 截走（0.11.0 发版时最后一步因此失败）。
  const result = spawnSync(command, args, {
    cwd: repoDir, env: process.env, encoding: 'utf8', shell: false, timeout: timeoutMs,
    stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
  });
  const ok = !result.error && result.status === 0;
  if (!ok && !allowFail) fail(`${command} 失败：${result.error ? result.error.message : `退出码 ${result.status ?? '未知'}`}`);
  return { ok, stdout: result.stdout || '' };
}

// 服务器偶尔直接断开 ssh（Connection closed，退出码 255，0.11.5 发版时拼块、对 sha 各断过一次），
// 所以远程命令也要重试。这里的命令都能安全重跑（mkdir -p、cat 覆盖写、sha256sum、rm -rf）。
function remote(command, { allowFail = false, ...options } = {}) {
  for (let attempt = 1; attempt <= transferRetries; attempt += 1) {
    const result = runTransfer('ssh', ['-o', 'ConnectTimeout=15', 'tencent', command], { ...options, allowFail: true });
    if (result.ok) return result;
    if (attempt < transferRetries) console.log(`  远程命令第 ${attempt} 次没成功，重试`);
  }
  if (!allowFail) fail(`ssh 失败（重试 ${transferRetries} 次）：${command.slice(0, 80)}`);
  return { ok: false, stdout: '' };
}

function scpWithRetry(localFile, remotePath) {
  for (let attempt = 1; attempt <= transferRetries; attempt += 1) {
    if (runTransfer('scp', ['-q', '-o', 'ConnectTimeout=15', localFile, `tencent:${remotePath}`], { allowFail: true }).ok) return;
    console.log(`  ${path.basename(localFile)} 第 ${attempt} 次没传完${attempt < transferRetries ? '，重试' : ''}`);
  }
  fail(`传不上去：${localFile}`);
}

function remoteSha(remoteFile) {
  const { ok, stdout } = remote(`sha256sum ${remoteFile} 2>/dev/null || true`, { allowFail: true, capture: true });
  return ok ? (stdout.trim().split(/\s+/)[0] || '') : '';
}

function uploadChecked(localFile, remoteDir, name) {
  const buffer = fs.readFileSync(localFile);
  const sha = createHash('sha256').update(buffer).digest('hex');
  const target = `${remoteDir}/${name}`;
  if (remoteSha(target) === sha) {
    console.log(`${name}：服务器上已是同一个文件，跳过`);
    return;
  }
  if (buffer.length <= chunkSize) {
    scpWithRetry(localFile, `${target}.tmp`);
  } else {
    const partsDir = path.join(outputRoot, `${versionOfDir(remoteDir)}-parts`);
    const remoteParts = `${remoteDir}/.parts-${name}`;
    fs.rmSync(partsDir, { recursive: true, force: true });
    fs.mkdirSync(partsDir, { recursive: true });
    remote(`rm -rf ${remoteParts} && mkdir -p ${remoteParts}`);
    const count = Math.ceil(buffer.length / chunkSize);
    for (let i = 0; i < count; i += 1) {
      const partName = `part.${String(i).padStart(3, '0')}`;
      const partFile = path.join(partsDir, partName);
      fs.writeFileSync(partFile, buffer.subarray(i * chunkSize, (i + 1) * chunkSize));
      console.log(`${name}：传第 ${i + 1}/${count} 块`);
      scpWithRetry(partFile, `${remoteParts}/${partName}`);
    }
    remote(`cat ${remoteParts}/part.* > ${target}.tmp && rm -rf ${remoteParts}`);
    fs.rmSync(partsDir, { recursive: true, force: true });
  }
  const got = remoteSha(`${target}.tmp`);
  if (got !== sha) fail(`${name} 传完后 sha256 对不上（本机 ${sha}，服务器 ${got || '读不到'}），没有换上正式名`);
  remote(`mv ${target}.tmp ${target} && chmod 644 ${target}`);
  console.log(`${name}：已上传，sha256 一致`);
}

function versionOfDir(remoteDir) {
  return path.posix.basename(remoteDir);
}

function usage() {
  console.log('用法：\n  node app/dev/release.mjs bump <版本>\n  node app/dev/release.mjs build [--notes "更新说明"] [--allow-dirty]\n  node app/dev/release.mjs upload <版本> [--dry-run]');
}

try {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'bump' && args.length === 1) bump(args[0]);
  else if (command === 'build') build(args);
  else if (command === 'upload' && args.length >= 1 && args.length <= 2 && (args.length === 1 || args[1] === '--dry-run')) upload(args[0], args.includes('--dry-run'));
  else usage();
} catch (error) {
  console.error(`发版失败：${error.message}`);
  process.exitCode = 1;
}
