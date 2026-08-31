import java.util.Properties

plugins {
    // Un seul plugin : depuis AGP 9.0 le support Kotlin est intégré, et le
    // plugin org.jetbrains.kotlin.android est explicitement rejeté
    // (« not compatible with AGP's 9.0 new DSL »).
    alias(libs.plugins.android.application)
}

// --- Signature de release (optionnelle) ------------------------------------
// Crée un fichier `keystore.properties` à la racine du projet (voir README) :
//   storeFile=/chemin/absolu/vers/tubeguard.jks
//   storePassword=...
//   keyAlias=tubeguard
//   keyPassword=...
// S'il est absent, le build release retombe sur la clé de debug (suffisant
// pour un sideload perso, mais l'APK ne sera pas mis à jour "proprement").
val keystorePropsFile = rootProject.file("keystore.properties")
val keystoreProps = Properties().apply {
    if (keystorePropsFile.exists()) keystorePropsFile.inputStream().use { load(it) }
}

android {
    namespace = "dev.stefan.tubeguard"
    // Android est passé aux plateformes versionnées en mineur : il faut ici
    // android-37.1 précisément, pas android-37.0.
    //   - androidx.core 1.19.0 (tiré par GeckoView) exige compileSdk >= 37
    //   - GeckoView 154 lui-même exige compileSdk >= 37.1
    // Installe « Android SDK Platform 37.1 » via le SDK Manager.
    compileSdk = 37
    compileSdkMinor = 1

    defaultConfig {
        applicationId = "dev.stefan.tubeguard"
        minSdk = 26
        // targetSdk volontairement une API en dessous de compileSdk : on compile
        // avec les dernières API sans hériter des changements de comportement
        // de la toute dernière plateforme, qui ne sont pas testés ici.
        targetSdk = 36
        versionCode = 1
        versionName = "1.0"
    }

    signingConfigs {
        if (keystorePropsFile.exists()) {
            create("release") {
                storeFile = file(keystoreProps.getProperty("storeFile"))
                storePassword = keystoreProps.getProperty("storePassword")
                keyAlias = keystoreProps.getProperty("keyAlias")
                keyPassword = keystoreProps.getProperty("keyPassword")
            }
        }
    }

    buildTypes {
        debug {
            isMinifyEnabled = false
            applicationIdSuffix = ".debug"
        }
        release {
            // R8 est laissé désactivé : GeckoView est déjà livré optimisé et
            // le minify n'apporte presque rien ici, alors qu'il peut casser
            // la réflexion utilisée par les délégués GeckoView.
            isMinifyEnabled = false
            isShrinkResources = false
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            signingConfig = if (keystorePropsFile.exists()) {
                signingConfigs.getByName("release")
            } else {
                signingConfigs.getByName("debug")
            }
        }
    }

    // GeckoView embarque des libs natives volumineuses (~60 Mo par ABI).
    // Un APK par ABI => ~90 Mo au lieu de ~180 Mo pour un APK universel.
    // Installe celui qui correspond à ton téléphone (arm64-v8a dans 99 % des cas).
    //
    // NE PAS ajouter `ndk { abiFilters += ... }` dans defaultConfig en plus :
    // AGP refuse les deux à la fois avec « Conflicting configuration : ... in
    // ndk abiFilters cannot be present when splits abi filters are set ».
    // Le `include` ci-dessous suffit à restreindre les ABI produites.
    splits {
        abi {
            isEnable = true
            reset()
            include("arm64-v8a", "armeabi-v7a")
            isUniversalApk = false
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    buildFeatures {
        buildConfig = true
        viewBinding = true
    }

    androidResources {
        // Les listes de filtres sont lues telles quelles par l'extension
        // (fetch sur moz-extension://) : on les laisse non compressées dans
        // l'APK. AGP 9 déprécie la forme méthode `noCompress("txt")` au profit
        // de la propriété.
        noCompress += "txt"
    }

    packaging {
        jniLibs {
            // false = les .so restent alignés et non compressés dans l'APK :
            // le système les mappe directement en mémoire au lieu de les
            // extraire. Indispensable vu la taille des binaires Gecko.
            useLegacyPackaging = false
        }
    }
}

dependencies {
    // ── Contrainte sur kotlin-stdlib ────────────────────────────────────
    // GeckoView déclare kotlin-stdlib 2.4.10 dans son POM, alors qu'il est
    // écrit à 100 % en Java (316 .java, 0 .kt) : cette dépendance ne lui sert
    // à rien. Elle casse en revanche la compilation, car le compilateur
    // Kotlin intégré à AGP 9 est en 2.2.10 et ne sait pas lire les
    // métadonnées 2.4 du stdlib — toutes les références au stdlib
    // (listOf, runCatching, it…) deviennent alors « unresolved ».
    // On la ramène donc à la version du compilateur. Sans risque : aucune
    // classe de GeckoView n'a besoin du stdlib.
    implementation(libs.kotlin.stdlib) {
        version { strictly(libs.versions.kotlin.get()) }
    }

    // Moteur Firefox — remplace WebView, seul moyen d'exécuter des WebExtensions.
    implementation(libs.geckoview)

    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.activity.ktx)
    // MediaSessionCompat + notification MediaStyle (lecture audio en arrière-plan).
    implementation(libs.androidx.media)
}
