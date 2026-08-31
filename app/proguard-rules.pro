# GeckoView utilise beaucoup de JNI + réflexion : on garde tout son package
# intact au cas où tu réactives minifyEnabled dans build.gradle.kts.
-keep class org.mozilla.geckoview.** { *; }
-keep class org.mozilla.gecko.** { *; }
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}
-dontwarn org.mozilla.**
