// Fichier de build racine — ne déclare que les plugins, sans les appliquer.
plugins {
    // Pas de plugin Kotlin : AGP 9 embarque son propre support Kotlin et
    // refuse `org.jetbrains.kotlin.android` (incompatible avec son nouveau DSL).
    alias(libs.plugins.android.application) apply false
}
