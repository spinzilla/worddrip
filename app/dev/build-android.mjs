// 安卓调试包：Rust 只编 arm64。Windows 没开开发者模式时，用复制代替 Tauri 的符号链接。
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tempRoot = 'D:\\tmp\\es-android';
const env = { ...process.env, CARGO_TARGET_DIR: 'E:\\rust\\target', GRADLE_USER_HOME: 'E:\\android\\gradle-home' };
delete env.CFLAGS;
delete env.CXXFLAGS;

// 调度进程可能没继承用户后来配置的工具链，只读注册表补齐，不写系统设置。
if (process.platform === 'win32') {
  try {
    const text = execFileSync('reg', ['query', 'HKCU\\Environment'], { encoding: 'utf8' });
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^\s+(\S+)\s+REG_(?:EXPAND_)?SZ\s+(.*)$/);
      if (m && ['JAVA_HOME', 'ANDROID_HOME', 'NDK_HOME'].includes(m[1])) env[m[1]] = m[2];
    }
  } catch { /* 已继承环境时不走这里 */ }
}
for (const key of ['JAVA_HOME', 'ANDROID_HOME', 'NDK_HOME']) {
  if (!env[key]) throw new Error(`缺少 ${key}，请先按任务卡配置安卓工具链`);
}

function run(command, args, options = {}) {
  const r = spawnSync(command, args, { cwd: appDir, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, shell: process.platform === 'win32', ...options });
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  return r;
}

// 本机 JDK 的 Unix 套接字不可用。补丁只放临时目录、只传给本次 Java 进程，强制 Pipe 使用 TCP。
function prepareTcpPipePatch() {
  const javaHome = env.JAVA_HOME;
  const srcZip = path.join(javaHome, 'lib', 'src.zip');
  if (!fs.existsSync(srcZip)) return '';
  const root = path.join(tempRoot, 'jdk-tcp-pipe');
  const source = path.join(root, 'src', 'java.base', 'sun', 'nio', 'ch', 'PipeImpl.java');
  const classes = path.join(root, 'classes');
  fs.mkdirSync(path.dirname(source), { recursive: true });
  fs.mkdirSync(classes, { recursive: true });
  if (!fs.existsSync(source)) {
    execFileSync('tar', ['-xf', srcZip, '-C', path.join(root, 'src'), 'java.base/sun/nio/ch/PipeImpl.java'], { stdio: 'inherit' });
  }
  const original = fs.readFileSync(source, 'utf8');
  const patched = original.replace('new Initializer(sp, preferAfUnix)', 'new Initializer(sp, false)');
  if (patched === original && !original.includes('new Initializer(sp, false)')) throw new Error('JDK PipeImpl 源码不匹配，不能应用 TCP 回退');
  fs.writeFileSync(source, patched);
  const javac = path.join(javaHome, 'bin', process.platform === 'win32' ? 'javac.exe' : 'javac');
  const r = run(javac, ['--patch-module', `java.base=${path.join(root, 'src')}`, '-d', classes, source]);
  if (r.status !== 0) throw new Error('编译临时 JDK TCP 回退失败');
  return classes;
}

// 打包前删掉旧 APK 和 Gradle 的增量打包缓存（packageArm64Debug），否则会在 APK 里留下中央目录之外的旧 .so 残留（体积翻倍）。
// 只删构建产物，不碰 E:\rust\target 和 Gradle 缓存。
const gradleBuild = path.join(appDir, 'src-tauri', 'gen', 'android', 'app', 'build');
fs.rmSync(path.join(gradleBuild, 'outputs', 'apk', 'arm64', 'debug'), { recursive: true, force: true });
fs.rmSync(path.join(gradleBuild, 'intermediates', 'incremental', 'packageArm64Debug'), { recursive: true, force: true });

const patch = prepareTcpPipePatch();
if (patch) env.JDK_JAVA_OPTIONS = [`--patch-module=java.base=${patch}`, env.JDK_JAVA_OPTIONS].filter(Boolean).join(' ');
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const args = ['tauri', 'android', 'build', '--debug', '--target', 'aarch64', '--apk'];
let built = run(npx, args);
if (built.status !== 0) {
  const output = `${built.stdout || ''}\n${built.stderr || ''}`;
  if (!output.includes('Creation symbolic link is not allowed')) process.exit(built.status || 1);
  const abiDir = path.join(appDir, 'src-tauri', 'gen', 'android', 'app', 'src', 'main', 'jniLibs', 'arm64-v8a');
  fs.mkdirSync(abiDir, { recursive: true });
  fs.copyFileSync(path.join(env.CARGO_TARGET_DIR, 'aarch64-linux-android', 'debug', 'liblinguaclip_lib.so'), path.join(abiDir, 'liblinguaclip_lib.so'));
  const gradlew = path.join(appDir, 'src-tauri', 'gen', 'android', process.platform === 'win32' ? 'gradlew.bat' : 'gradlew');
  built = run(gradlew, ['--no-daemon', '-p', path.join(appDir, 'src-tauri', 'gen', 'android'), ':app:assembleArm64Debug', '-x', ':app:rustBuildArm64Debug', '-PabiList=arm64-v8a', '-ParchList=arm64', '-PtargetList=aarch64', '--console=plain']);
}
if (built.status !== 0) process.exit(built.status || 1);
const apk = path.join(appDir, 'src-tauri', 'gen', 'android', 'app', 'build', 'outputs', 'apk', 'arm64', 'debug', 'app-arm64-debug.apk');
if (!fs.existsSync(apk)) throw new Error(`构建结束但没有 APK：${apk}`);
fs.mkdirSync(tempRoot, { recursive: true });
const delivered = path.join(tempRoot, 'worddrip-arm64-debug.apk');
fs.copyFileSync(apk, delivered);
console.log(`APK：${delivered}（${fs.statSync(delivered).size} 字节）`);
