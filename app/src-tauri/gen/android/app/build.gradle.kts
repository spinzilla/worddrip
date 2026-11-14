import java.util.Properties
import java.io.File

val releaseDir = System.getenv("WORDDRIP_RELEASE_DIR")
    ?.takeIf { it.isNotBlank() }
    ?.let { File(it) }
    ?: File(System.getProperty("user.home"), ".worddrip-release")
val releasePropertiesFile = File(releaseDir, "keystore.properties")
val releaseProperties = Properties().apply {
    if (releasePropertiesFile.isFile) {
        releasePropertiesFile.inputStream().use { load(it) }
    }
}
val hasReleaseSigning = releasePropertiesFile.isFile &&
    listOf("storeFile", "storePassword", "keyAlias", "keyPassword")
        .all { !releaseProperties.getProperty(it).isNullOrBlank() }

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("rust")
}

val tauriProperties = Properties().apply {
    val propFile = file("tauri.properties")
    if (propFile.exists()) {
        propFile.inputStream().use { load(it) }
    }
}

android {
    compileSdk = 35
    namespace = "com.englishstudio.app"
    defaultConfig {
        manifestPlaceholders["usesCleartextTraffic"] = "false"
        applicationId = "com.englishstudio.app"
        minSdk = 24
        targetSdk = 35
        versionCode = tauriProperties.getProperty("tauri.android.versionCode", "1").toInt()
        versionName = tauriProperties.getProperty("tauri.android.versionName", "1.0")
    }
    if (hasReleaseSigning) {
        signingConfigs.create("worddripRelease") {
            val configuredStore = File(releaseProperties.getProperty("storeFile"))
            storeFile = if (configuredStore.isAbsolute) configuredStore else File(releaseDir, configuredStore.path)
            storePassword = releaseProperties.getProperty("storePassword")
            keyAlias = releaseProperties.getProperty("keyAlias")
            keyPassword = releaseProperties.getProperty("keyPassword")
        }
    }
    buildTypes {
        getByName("debug") {
            manifestPlaceholders["usesCleartextTraffic"] = "true"
            isDebuggable = true
            isJniDebuggable = true
            isMinifyEnabled = false
            packaging {                jniLibs.keepDebugSymbols.add("*/arm64-v8a/*.so")
                jniLibs.keepDebugSymbols.add("*/armeabi-v7a/*.so")
                jniLibs.keepDebugSymbols.add("*/x86/*.so")
                jniLibs.keepDebugSymbols.add("*/x86_64/*.so")
            }
        }
        getByName("release") {
            // 暂不开 R8：先确认 Tauri/插件反射类都有 keep 规则，避免正式包运行时缺类。
            isMinifyEnabled = false
            if (hasReleaseSigning) signingConfig = signingConfigs.getByName("worddripRelease")
            proguardFiles(
                *fileTree(".") { include("**/*.pro") }
                    .plus(getDefaultProguardFile("proguard-android-optimize.txt"))
                    .toList().toTypedArray()
            )
        }
    }
    kotlinOptions {
        jvmTarget = "1.8"
    }
    buildFeatures {
        buildConfig = true
    }
}

// 只在请求 release 任务时检查签名材料，缺材料不能误伤 debug 构建。
val validateWorddripReleaseSigning by tasks.registering {
    doLast {
        val required = listOf("storeFile", "storePassword", "keyAlias", "keyPassword")
        val missing = !releasePropertiesFile.isFile || required.any {
            releaseProperties.getProperty(it).isNullOrBlank()
        }
        val storePath = releaseProperties.getProperty("storeFile")?.let { File(it) }
        val resolvedStore = storePath?.let { if (it.isAbsolute) it else File(releaseDir, it.path) }
        if (missing || resolvedStore?.isFile != true) {
            throw GradleException("Missing Android release signing material. Check WORDDRIP_RELEASE_DIR/keystore.properties and its keystore file.")
        }
    }
}
tasks.configureEach {
    if (name.contains("Release", ignoreCase = true) &&
        (name.startsWith("assemble") || name.startsWith("package") || name.startsWith("bundle"))) {
        dependsOn(validateWorddripReleaseSigning)
    }
}

rust {
    rootDirRel = "../../../"
}

dependencies {
    implementation("androidx.webkit:webkit:1.14.0")
    implementation("androidx.appcompat:appcompat:1.7.1")
    implementation("androidx.activity:activity-ktx:1.10.1")
    implementation("com.google.android.material:material:1.12.0")
    implementation("androidx.lifecycle:lifecycle-process:2.10.0")
    testImplementation("junit:junit:4.13.2")
    androidTestImplementation("androidx.test.ext:junit:1.1.4")
    androidTestImplementation("androidx.test.espresso:espresso-core:3.5.0")
}

apply(from = "tauri.build.gradle.kts")
