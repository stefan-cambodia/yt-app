pluginManagement {
    repositories {
        google {
            content {
                includeGroupByRegex("com\\.android.*")
                includeGroupByRegex("com\\.google.*")
                includeGroupByRegex("androidx.*")
            }
        }
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
        // Dépôt Maven officiel de Mozilla : c'est le SEUL endroit où GeckoView
        // (org.mozilla.geckoview:geckoview) est publié pour le canal "release".
        maven {
            name = "Mozilla"
            url = uri("https://maven.mozilla.org/maven2/")
            content {
                includeGroup("org.mozilla.geckoview")
                includeGroupByRegex("org\\.mozilla\\..*")
            }
        }
    }
}

rootProject.name = "TubeGuard"
include(":app")
