plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
}

android {
    namespace = "com.mediacleaner.nativeapp"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.mediacleaner.app.nativepreview"
        minSdk = 30
        targetSdk = 36
        versionCode = providers.gradleProperty("nativeBuildNumber").getOrElse("1").toInt()
        versionName = "0.0.1"
        buildConfigField("boolean", "UPDATE_PRERELEASE", providers.gradleProperty("nativePrerelease").getOrElse("true"))
    }

    val signingFile = System.getenv("NATIVE_KEYSTORE_FILE")
    if (!signingFile.isNullOrBlank()) {
        val nativeSigning = signingConfigs.create("nativeRelease") {
            storeFile = file(signingFile)
            storePassword = System.getenv("NATIVE_STORE_PASSWORD")
            keyAlias = System.getenv("NATIVE_KEY_ALIAS")
            keyPassword = System.getenv("NATIVE_KEY_PASSWORD")
        }
        buildTypes.getByName("release").signingConfig = nativeSigning
        buildTypes.getByName("debug").signingConfig = nativeSigning
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_21
        targetCompatibility = JavaVersion.VERSION_21
    }
    buildFeatures { compose = true; buildConfig = true }
    packaging { resources.excludes += "/META-INF/{AL2.0,LGPL2.1}" }
}

kotlin {
    jvmToolchain(21)
    compilerOptions { freeCompilerArgs.add("-Xcontext-parameters") }
}

dependencies {
    val composeBom = platform("androidx.compose:compose-bom:2026.02.01")
    implementation(composeBom)
    implementation("androidx.activity:activity-compose:1.12.4")
    implementation("androidx.core:core-ktx:1.17.0")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.10.0")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.10.0")
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.foundation:foundation")
    implementation("androidx.compose.ui:ui-tooling-preview")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.material:material-icons-extended")
    implementation("io.github.kyant0:backdrop:1.0.6")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.10.2")
    implementation("androidx.media3:media3-exoplayer:1.8.0")
    implementation("androidx.media3:media3-ui:1.8.0")
    debugImplementation("androidx.compose.ui:ui-tooling")
}
