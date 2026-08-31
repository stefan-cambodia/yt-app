# TubeGuard

Navigateur dédié à YouTube pour Android, bâti sur **GeckoView** (le moteur de
Firefox), avec blocage de publicités intégré. Une seule Activity plein écran,
pas de barre d'adresse : ça se comporte comme une app native.

**Usage strictement personnel, installation par APK sideloadé.** Voir la
section [Aspects légaux](#aspects-légaux) — ce projet contourne les CGU de
YouTube et n'a pas vocation à être publié.

---

## Sommaire

1. [Ce que fait l'app](#1-ce-que-fait-lapp)
2. [Pourquoi GeckoView et pas WebView](#2-pourquoi-geckoview-et-pas-webview)
3. [Le blocage de publicités : Plan A et Plan B](#3-le-blocage-de-publicités--plan-a-et-plan-b)
4. [Compiler l'APK](#4-compiler-lapk)
5. [Installer par sideload](#5-installer-par-sideload)
6. [Rendre l'interception des liens effective (Android 12+)](#6-rendre-linterception-des-liens-effective-android-12)
7. [Structure du projet](#7-structure-du-projet)
8. [Déboguer](#8-déboguer)
9. [Limites connues](#9-limites-connues)
10. [Aspects légaux](#10-aspects-légaux)

---

## 1. Ce que fait l'app

| Fonctionnalité | Où c'est implémenté |
|---|---|
| Activity unique plein écran, mode immersif, `m.youtube.com` au démarrage | `MainActivity.applyImmersiveMode()`, `GeckoEngine.HOME_URL` |
| Bouton retour Android → historique GeckoView | `MainActivity.setupBackNavigation()` |
| Session persistante (cookies, compte Google, onglet courant) | `GeckoEngine` (profil Gecko + `SessionState` sérialisé) |
| Interception des liens `youtube.com` / `youtu.be` / `m.youtube.com` | `AndroidManifest.xml` (intent-filters) + `YouTubeLinks.normalize()` |
| Picture-in-Picture natif (miniature ; la vidéo s'y met en pause — voir Limites) | `MainActivity.enterPip()` |
| Audio en arrière-plan écran éteint (MediaSession + wake lock) | `PlaybackService`, `MediaBridge` |
| Icône et nom personnalisés, sans marque YouTube | `res/drawable/ic_launcher_foreground.xml`, `strings.xml` |
| Blocage de pub | `AdBlock.kt` + `assets/extensions/ytblock/` |

Détails d'implémentation qui méritent un mot :

- **Bouton retour.** Trois niveaux : sortir du plein écran vidéo → reculer dans
  l'historique → mettre l'app en arrière-plan (`moveTaskToBack`) plutôt que la
  fermer, pour ne pas couper l'audio.
- **Liens externes.** Un lien qui sort du périmètre YouTube/Google (sponsor
  dans une description, par exemple) est ouvert dans le vrai navigateur —
  l'app reste une app YouTube, pas un navigateur généraliste. Voir
  `YouTubeLinks.INTERNAL_SUFFIXES`.
- **Picture-in-Picture.** L'app entre bien en miniature, mais **la vidéo s'y met
  en pause** : le lecteur mobile YouTube se coupe en PiP par un mécanisme qui
  résiste au contournement (voir la section 9, « Limites connues »). La
  promotion CSS de la vidéo dans la vignette a été désactivée. Pour du
  multitâche, la voie fiable est l'**audio en arrière-plan** (écran éteint ou
  bascule d'app), qui, lui, fonctionne.

---

## 2. Pourquoi GeckoView et pas WebView

La `WebView` d'Android n'exécute pas de WebExtensions. Sans WebExtension, pas
de `webRequest` bloquant, donc pas de blocage de pub digne de ce nom : il ne
resterait que l'injection de CSS/JS via `evaluateJavascript`, qui ne peut rien
contre les pré-rolls.

GeckoView embarque Gecko complet, avec le support des WebExtensions MV2. C'est
la seule option viable sur Android en dehors de forks de Chromium.

**Contrepartie : l'APK est énorme.** Tailles réellement mesurées sur ce projet
(build release) :

| APK | Taille |
|---|---|
| `app-arm64-v8a-release.apk` | **195 Mo** |
| `app-armeabi-v7a-release.apk` | 157 Mo |

À lui seul, `libxul.so` (le moteur Gecko) pèse 152 Mo. Le `splits { abi }` dans
`app/build.gradle.kts` évite au moins de cumuler les deux architectures dans un
APK universel de ~350 Mo.

Si les 195 Mo posent problème pour transférer l'APK sur le téléphone, tu peux
passer `useLegacyPackaging = true` dans le bloc `packaging.jniLibs` : les `.so`
sont alors compressés dans l'APK (`libxul.so` tombe à 61 Mo, soit un APK
d'environ 75 Mo). Le prix à payer : Android les décompresse à l'installation,
donc l'espace occupé sur le téléphone double et le premier lancement est plus
lent. Le réglage par défaut du projet (`false`, non compressé) est le
comportement moderne recommandé.

---

## 3. Le blocage de publicités : Plan A et Plan B

### Plan A — uBlock Origin embarqué (`ensureBuiltIn`)

Le code est écrit et fonctionnel dans `AdBlock.installUBlock()`. Il charge uBO
depuis `assets/extensions/ublock/` via
`WebExtensionController.ensureBuiltIn("resource://android/assets/extensions/ublock/", "uBlock0@raymondhill.net")`.

> ### ⚠️ Prévenu comme demandé : ce Plan A a de fortes chances d'échouer.
>
> Les extensions « builtIn » de GeckoView sont validées avec un jeu de
> permissions restreint. Le `manifest.json` d'uBlock Origin déclare des
> permissions qui sont régulièrement refusées dans ce contexte :
>
> - `webRequestBlocking` — restreinte selon les builds aux extensions
>   privilégiées ou signées par Mozilla ;
> - `menus` / `contextMenus` — GeckoView n'a pas d'UI de menu à offrir ;
> - `privacy`, `browsingData`, `unlimitedStorage`, `dns` ;
> - `"background": { "persistent": true }` sur les versions MV2 ;
> - les clés MV3 (`declarative_net_request`, `host_permissions`, `action`) sur
>   uBO ≥ 1.60.
>
> L'échec se manifeste par `Extension is invalid`, `ERROR_CORRUPT_FILE` ou
> `permission not allowed: <permission>`. Le message exact est loggé sous le
> tag `TubeGuard.AdBlock`.

Le dossier `assets/extensions/ublock/` est livré **vide** (je ne redistribue pas
le code d'uBO). Pour tester : voir `assets/extensions/ublock/LISEZ-MOI.txt`.

### Plan B — extension maison `ytblock` ✅ **ACTIVE PAR DÉFAUT**

C'est ce qui tourne quand tu installes l'APK tel quel. La constante qui décide :

```kotlin
// app/src/main/java/dev/stefan/tubeguard/AdBlock.kt
val STRATEGY: Strategy = Strategy.PLAN_B_ONLY   // <-- actif par défaut
```

Les trois valeurs possibles : `PLAN_A_ONLY`, `PLAN_A_THEN_B` (tente uBO, bascule
automatiquement en cas de refus), `PLAN_B_ONLY`.

L'extension `ytblock` reprend les trois mécanismes d'uBlock Origin :

**a) Blocage réseau** — `background.js` + `lib/filters.js`
Moteur de filtres au format Adblock Plus (sous-ensemble : `||domaine^`,
ancrages, jokers, options `$script,third-party,domain=`, exceptions `@@`,
filtres cosmétiques `##`). Branché sur `webRequest.onBeforeRequest` en mode
`blocking`.

**b) Listes de filtres** — `filters/`
- `filters/youtube.txt` : liste maison, endpoints pub YouTube + sélecteurs
  cosmétiques `ytm-*` / `ytd-*` / `ytp-*`.
- `filters/easylist-min.txt` : noyau d'EasyList embarqué (~140 règles) pour que
  le blocage marche dès la première seconde, hors ligne.
- **La vraie EasyList complète est téléchargée automatiquement** au premier
  démarrage, mise en cache dans `storage.local`, rafraîchie tous les 3 jours.
  Réglable dans `CONFIG.remoteUpdate` (`background.js`), désactivable si tu ne
  veux aucune requête réseau au démarrage.

**c) Filtrage cosmétique et saut des coupures** — `content/ads.js` + `ads.css`
C'est la partie qui fait réellement le travail sur YouTube :

1. **Neutralisation du `playerResponse`.** YouTube décrit ses coupures pub dans
   les clés JSON `adPlacements`, `playerAds`, `adSlots`. Le content script les
   supprime avant que le lecteur ne les lise, via un hook sur `JSON.parse` et un
   accesseur sur `window.ytInitialPlayerResponse`. Le lecteur croit alors qu'il
   n'y a aucune coupure à jouer.
   Les hooks utilisent `wrappedJSObject` / `exportFunction` / `cloneInto` — la
   méthode Firefox native, et la seule qui passe malgré la CSP stricte de
   YouTube, qui interdit d'injecter un `<script>` inline.
2. **Filet de sécurité.** Si une pré-roll ou mid-roll démarre quand même :
   détection (`ad-showing`), coupure du son, saut à la fin du spot
   (`video.currentTime = video.duration`), clic sur « Passer l'annonce ».
3. **Cosmétique.** `ads.css` est injecté à `document_start`, donc avant le
   premier rendu : les bandeaux ne clignotent pas avant d'être masqués.

> **Garde-fou important.** Sur YouTube, pub et vidéo transitent par les mêmes
> endpoints (`/youtubei/v1/player`, `*.googlevideo.com/videoplayback`). Un
> blocage réseau trop large ne supprime pas la pub, il casse la lecture. D'où
> la liste `NEVER_BLOCK` en tête de `background.js`, vérifiée avant toute
> règle. Ne la retire pas.

### Plan A bis — installer uBO depuis addons.mozilla.org

Le `.xpi` d'AMO est signé par Mozilla, ce qui lève une partie des restrictions
pesant sur les extensions « builtIn ». Ce code **n'est pas** dans le projet
parce que la signature du `PromptDelegate` change d'une version de GeckoView à
l'autre — mais voici la version **vérifiée contre les sources de GeckoView
154**, prête à coller dans `AdBlock.kt` :

```kotlin
// ⚠️ Vérifié pour GeckoView 154. Sur GeckoView ≤ 12x, la méthode s'appelait
//    onInstallPrompt(extension) et renvoyait GeckoResult<AllowOrDeny>.
runtime.webExtensionController.promptDelegate =
    object : WebExtensionController.PromptDelegate {
        override fun onInstallPromptRequest(
            extension: WebExtension,
            permissions: Array<String>,
            origins: Array<String>,
            dataCollectionPermissions: Array<String>
        ): GeckoResult<WebExtension.PermissionPromptResponse> =
            GeckoResult.fromValue(
                WebExtension.PermissionPromptResponse(
                    /* isPermissionsGranted = */ true,
                    /* isPrivateModeGranted = */ false,
                    /* isTechnicalAndInteractionDataGranted = */ false
                )
            )
    }

runtime.webExtensionController
    .install("https://addons.mozilla.org/firefox/downloads/latest/ublock-origin/latest.xpi")
    .accept(
        { ext -> Log.i("AdBlock", "uBO installé depuis AMO : ${ext?.metaData?.version}") },
        { err -> Log.e("AdBlock", "échec AMO", err) }
    )
```

Contrairement à `ensureBuiltIn()`, `install()` télécharge l'extension au premier
lancement (donc : connexion réseau requise) et la stocke dans le profil Gecko.

---

## 4. Compiler l'APK

### Prérequis

- **JDK 17 à 21.** Le JBR fourni avec Android Studio convient (JBR 25 testé ici).
- **Android SDK** avec exactement ces composants :
  - `platforms;android-37.1` — **la version mineure compte** : GeckoView 154
    exige `compileSdk 37.1`, et `android-37.0` est refusé.
  - `build-tools;37.0.0`
  - `platform-tools` (pour `adb`)

> **La chaîne de versions n'est pas négociable**, elle est imposée en cascade :
>
> ```
> geckoview 154 ──dépend de──▶ androidx.core 1.19.0 ──exige──▶ compileSdk ≥ 37
>                                                              AGP ≥ 9.1.0
> geckoview 154 ────────────────────────────────────exige──▶ compileSdk ≥ 37.1
> ```
>
> D'où, dans `app/build.gradle.kts` :
> ```kotlin
> compileSdk = 37
> compileSdkMinor = 1   // android-37.0 ne suffit pas
> ```
>
> **Si ton Android Studio est trop ancien pour AGP 9**, ne force pas une version
> d'`androidx.core` plus basse que celle attendue par le moteur — tu casserais
> GeckoView au runtime. Rétrograde plutôt GeckoView dans
> `gradle/libs.versions.toml` (essaie `"146.+"`, puis `"140.+"`).

### Installer le SDK en ligne de commande

Android Studio seul ne suffit pas : le paquet de l'IDE ne contient pas le SDK.
Si tu ne veux pas passer par son assistant graphique :

```fish
# 1. Les command-line tools de Google (~165 Mo)
cd /tmp
curl -L -O https://dl.google.com/android/repository/commandlinetools-linux-13114758_latest.zip
mkdir -p ~/Android/Sdk/cmdline-tools
unzip -q commandlinetools-linux-13114758_latest.zip -d ~/Android/Sdk/cmdline-tools
mv ~/Android/Sdk/cmdline-tools/cmdline-tools ~/Android/Sdk/cmdline-tools/latest

# 2. Les composants (le JDK d'Android Studio est requis par sdkmanager)
set -x JAVA_HOME /opt/android-studio/jbr
set -x SDK $HOME/Android/Sdk
yes | $SDK/cmdline-tools/latest/bin/sdkmanager --sdk_root=$SDK --licenses
$SDK/cmdline-tools/latest/bin/sdkmanager --sdk_root=$SDK \
    platform-tools "platforms;android-37.1" "build-tools;37.0.0"
```

### Trois réglages de build à connaître

Ils sont déjà en place dans le projet, mais ce sont les deux pièges d'AGP 9 :

**1. Pas de plugin Kotlin.** Depuis AGP 9.0, le support Kotlin est intégré au
plugin Android. Déclarer `org.jetbrains.kotlin.android` fait échouer le build :
*« The 'org.jetbrains.kotlin.android' plugin is not compatible with AGP's 9.0
new DSL »*. Le contournement `android.builtInKotlin=false` ne sert à rien non
plus, il rouvre juste le même conflit sur le nouveau DSL.

**2. `kotlin-stdlib` doit être contraint.** GeckoView déclare
`kotlin-stdlib 2.4.10` dans son POM alors qu'il est écrit à 100 % en Java
(316 fichiers `.java`, zéro `.kt`) : cette dépendance ne lui sert à rien. Elle
casse en revanche la compilation, parce que le compilateur Kotlin embarqué dans
AGP 9 est en 2.2.10 et ne sait pas lire des métadonnées 2.4 :

```
Class 'kotlin.Unit' was compiled with an incompatible version of Kotlin.
The actual metadata version is 2.4.0, but the compiler version 2.2.0
can read versions up to 2.3.0.
```

Toutes les références au stdlib (`listOf`, `runCatching`, `it`…) deviennent
alors « unresolved ». D'où, dans `app/build.gradle.kts` :

```kotlin
implementation(libs.kotlin.stdlib) {
    version { strictly(libs.versions.kotlin.get()) }   // 2.2.10
}
```

**3. `ndk.abiFilters` et `splits.abi` s'excluent.** Déclarer les deux donne
*« Conflicting configuration : … in ndk abiFilters cannot be present when
splits abi filters are set »*. Le projet n'utilise que `splits`.

### Depuis Android Studio

1. `File > Open` → sélectionne le dossier `yt-app`.
2. Laisse la synchronisation Gradle se terminer. Le premier build télécharge
   GeckoView depuis `maven.mozilla.org` — compte plusieurs minutes et ~200 Mo.
3. `Build > Build Bundle(s) / APK(s) > Build APK(s)`.

### En ligne de commande

```fish
cd /home/stefan/videcode/android/yt-app

# Indique où est ton SDK Android (adapte le chemin si besoin)
echo "sdk.dir=$HOME/Android/Sdk" > local.properties

# Build de debug (le plus rapide pour tester)
./gradlew assembleDebug

# Build de release
./gradlew assembleRelease
```

**JDK.** Gradle 9.7 ne supporte pas les JDK les plus récents (un JDK 26 système
est refusé). Le projet pointe donc explicitement sur le JDK d'Android Studio,
via `gradle.properties` :

```properties
org.gradle.java.home=/opt/android-studio/jbr
```

Adapte ce chemin si ton Android Studio est ailleurs, ou supprime la ligne si tu
as déjà un JDK 17/21 par défaut.

Le wrapper Gradle livré bootstrape correctement la 9.7.1, mais son `.jar` vient
d'une version antérieure ; `./gradlew wrapper --gradle-version 9.7.1` le
régénère proprement si tu veux.

Les APK atterrissent dans :

```
app/build/outputs/apk/debug/app-arm64-v8a-debug.apk
app/build/outputs/apk/release/app-arm64-v8a-release.apk
```

**Prends la variante `arm64-v8a`** — c'est l'architecture de tous les téléphones
Android depuis ~2017. `armeabi-v7a` n'est là que pour les vieux appareils.

### Version de GeckoView

`gradle/libs.versions.toml` pointe sur une version **figée et vérifiée** :

```toml
geckoview = "154.0.20260824154132"
```

Toutes les API GeckoView utilisées dans le code Kotlin ont été contrôlées une
par une contre les sources de ce build précis (délégués `MediaSession`,
`ensureBuiltIn`, `WebExtension.MessageDelegate`, builders de settings,
constantes `ContentBlocking`…).

Mozilla publie une nouvelle version toutes les ~4 semaines. Pour suivre
automatiquement la branche, mets `"154.+"` ; pour passer à une branche plus
récente, prends le dernier dossier de
<https://maven.mozilla.org/?prefix=maven2/org/mozilla/geckoview/geckoview/>.
Attention : une branche plus récente peut relever à nouveau le `compileSdk`
minimum exigé.

### Signer le build de release (optionnel)

Sans clé, le build release retombe sur la clé de debug : ça s'installe, mais
Android traitera un futur APK signé différemment comme une autre app (il faudra
désinstaller/réinstaller et tu perdras ta session). Pour une clé stable :

```fish
keytool -genkey -v -keystore ~/tubeguard.jks -keyalg RSA -keysize 2048 \
        -validity 10000 -alias tubeguard
```

Puis crée `keystore.properties` à la racine (il est déjà dans `.gitignore`) :

```properties
storeFile=/home/stefan/tubeguard.jks
storePassword=ton_mot_de_passe
keyAlias=tubeguard
keyPassword=ton_mot_de_passe
```

---

## 5. Installer par sideload

### Via ADB (recommandé)

Active **Options pour les développeurs** sur le téléphone (7 tapes sur le numéro
de build dans *Paramètres > À propos*), puis **Débogage USB**.

```fish
adb devices          # accepte l'autorisation affichée sur le téléphone
adb install -r app/build/outputs/apk/release/app-arm64-v8a-release.apk
```

`-r` réinstalle par-dessus en conservant les données (donc ta session Google),
à condition que la clé de signature soit la même.

### Sans PC

Copie l'APK sur le téléphone, ouvre-le avec le gestionnaire de fichiers, et
autorise « Installer des applications inconnues » pour cette app quand Android
le demande.

---

## 6. Rendre l'interception des liens effective (Android 12+)

**C'est l'étape que tout le monde oublie.** Depuis Android 12, un intent-filter
`VIEW` sur `https://youtube.com` ne suffit plus : Android exige une vérification
*App Links* via un fichier `/.well-known/assetlinks.json` hébergé sur
`youtube.com`. Évidemment impossible. Le manifest déclare donc
`android:autoVerify="false"`, et **tu dois autoriser l'app à la main** :

> **Paramètres → Applications → TubeGuard → Ouvrir par défaut**
> (ou « Liens de l'application » / « Ouvrir les liens compatibles »)
> → active **Ouvrir les liens compatibles**
> → **Liens compatibles** → coche tous les domaines YouTube.

Vérification en ligne de commande :

```fish
adb shell pm get-app-links dev.stefan.tubeguard

# Forcer l'association (Android 12+, sans passer par l'UI)
adb shell pm set-app-links --package dev.stefan.tubeguard 2 all
```

Un filtre `SEND` (« Partager vers TubeGuard ») est aussi déclaré comme repli :
il fonctionne sans aucune configuration.

---

## 7. Structure du projet

```
yt-app/
├── app/build.gradle.kts               deps Mozilla, splits ABI, signature
├── gradle/libs.versions.toml          version de GeckoView
└── app/src/main/
    ├── AndroidManifest.xml            permissions, intent-filters, PiP, service
    ├── java/dev/stefan/tubeguard/
    │   ├── TubeGuardApp.kt            init du runtime + du bloqueur
    │   ├── GeckoEngine.kt             runtime/session singletons, persistance
    │   ├── MainActivity.kt            immersif, retour, PiP, délégués Gecko
    │   ├── AdBlock.kt                 ← Plan A / Plan B, constante STRATEGY
    │   ├── NativeBridge.kt            canal app ↔ content script
    │   ├── MediaBridge.kt             état du lecteur web
    │   ├── PlaybackService.kt         foreground service + wake lock
    │   └── YouTubeLinks.kt            normalisation des URL entrantes
    └── assets/extensions/
        ├── ublock/                    ← Plan A : vide, à remplir toi-même
        │   └── LISEZ-MOI.txt
        └── ytblock/                   ← Plan B : l'extension maison
            ├── manifest.json          MV2, permissions minimales
            ├── background.js          blocage réseau + màj des listes
            ├── lib/filters.js         moteur de filtres format ABP
            ├── content/ads.js         hooks playerResponse + saut des pubs
            ├── content/ads.css        filtres cosmétiques
            └── filters/*.txt          listes embarquées
```

---

## 8. Déboguer

**Logs de l'app :**

```fish
adb logcat -s TubeGuard TubeGuard.AdBlock TubeGuard.Main TubeGuard.Media TubeGuard.Bridge
```

**Console de l'extension et DOM de la page** — c'est l'outil indispensable pour
réparer les sélecteurs quand YouTube change son HTML. En build debug,
`remoteDebuggingEnabled` est actif :

```fish
adb forward tcp:6000 localfilesystem:/data/data/dev.stefan.tubeguard.debug/firefox-debugger-socket
```

Puis dans **Firefox desktop** : `about:debugging` → *Configuration réseau* →
ajoute `localhost:6000` → *Connexion*. Tu as l'inspecteur complet et la console
de `content/ads.js`.

**Vérifier que le bloqueur tourne :** cherche dans la console
`[ytblock] moteur prêt` puis `[ytblock] content script actif sur …`.

---

## 9. Limites connues

À lire avant de te demander « pourquoi ça marche plus ».

### Le blocage de pub est une course à l'armement, et YouTube a l'avantage

- **YouTube modifie régulièrement son lecteur**, parfois spécifiquement pour
  casser ce type de contournement. Les noms de clés JSON (`adPlacements`…) et
  les classes CSS (`ad-showing`, `ytp-ad-skip-button`) sur lesquels repose
  `content/ads.js` peuvent disparaître du jour au lendemain. **Quand ça arrive,
  il faut mettre le fichier à jour** — inspecte la page avec `about:debugging`
  et corrige les sélecteurs. C'est exactement le travail que fait l'équipe
  d'uBlock Origin en continu ; ici, c'est à toi de le faire.
- **YouTube détecte les bloqueurs** et affiche depuis 2023 des interstitiels
  (« Les bloqueurs de publicités ne sont pas autorisés »), voire ralentit
  artificiellement le chargement du lecteur. Rien ici ne garantit d'y échapper
  durablement.
- **Server-side ad insertion.** Si YouTube généralise l'insertion des pubs
  directement dans le flux vidéo (comme Twitch l'a fait), aucune des deux
  approches ci-dessus ne fonctionnera : la pub et la vidéo seront le même
  fichier. C'est un risque structurel, pas un bug à corriger.
- **Le moteur de filtres est un sous-ensemble d'ABP.** Il ignore les filtres
  procéduraux d'uBO (`#?#`, `:has-text()`, `:xpath()`), les scriptlets
  (`##+js(...)`), les redirections (`$redirect=`), `$csp=`, `$removeparam=` et
  les regex natives. Le taux de blocage est donc inférieur à celui d'uBO sur le
  web en général. Sur YouTube c'est peu gênant : l'essentiel est fait par le
  content script.

### Lecture en arrière-plan et Picture-in-Picture (testé sur Galaxy A56)

Comportement réel constaté et corrigé sur l'appareil, à connaître :

- **Audio en arrière-plan : fonctionne** (écran éteint ou bascule vers une autre
  app). Deux mécanismes le rendent fiable :
  1. le `PlaybackService` (foreground + wake lock) garde le process vivant ;
  2. surtout, `MainActivity` **ré-affirme `GeckoSession.setActive(true)` toutes
     les 3 secondes** tant que l'app est en arrière-plan et joue. Sans ça,
     GeckoView programme une « pression mémoire » différée quand la vue devient
     inactive, et le son se coupait au bout de quelques dizaines de secondes —
     y compris avec la batterie réglée sur « Sans restriction ». Le réglage
     batterie reste utile, mais ne suffit pas à lui seul.
- **YouTube coupe la lecture sur perte de visibilité ET de focus.** Le content
  script (`ads.js`) spoofe donc les DEUX : `document.hidden` / `visibilityState`
  (toujours « visible ») et `document.hasFocus()` (toujours vrai), et avale les
  évènements `visibilitychange` / `blur` de la fenêtre. Ces noms d'API sont
  stables, mais si une future version du lecteur mobile trouve un autre signal,
  la lecture pourra à nouveau se couper en arrière-plan.
- **Picture-in-Picture vidéo : NE tient PAS la lecture.** La vidéo se met en
  pause dès l'entrée en miniature. En cause : même visibilité et focus spoofés,
  le lecteur mobile YouTube se remet en pause en boucle en PiP (probablement lié
  au redimensionnement de la fenêtre), et une relance native lutte sans jamais
  tenir — ce qui produisait une saccade. Cette relance a été **retirée** : le
  PiP se met donc en pause **proprement**. C'est une **limite dure de GeckoView**
  pour ce cas ; la voie fiable pour écouter en multitâche est l'audio en
  arrière-plan ci-dessus. La promotion CSS qui devait cadrer la vignette sur la
  seule vidéo a aussi été désactivée (elle provoquait un écran noir au démarrage
  quand sa classe restait collée après une sortie de PiP).

### Le reste

- **Plan A quasi condamné** — voir la section 3. Le repli automatique
  (`PLAN_A_THEN_B`) existe précisément pour ça.
- **Taille de l'APK** : 195 Mo en arm64 (mesuré), dont 152 Mo pour le seul
  `libxul.so`. C'est le prix de Gecko. Voir la section 2 pour l'option de
  compression qui ramène ça à ~75 Mo au détriment de l'espace sur le téléphone.
- **Interception des liens** : ne marche pas tant que tu n'as pas fait la
  manip de la section 6. Ce n'est pas un bug, c'est une contrainte d'Android 12+.
- **Réglage batterie** : même si la ré-affirmation `setActive` évite la coupure
  côté GeckoView, garde TubeGuard en « **Sans restriction** » (One UI :
  *Paramètres → Applications → TubeGuard → Batterie*) et hors « veille profonde »
  — les surcouches constructeur (One UI, MIUI, ColorOS, EMUI) tuent volontiers
  les services de lecture prolongés.
- **Autoplay** : Gecko peut bloquer le démarrage automatique de la vidéo
  suivante. Si ça te gêne, active `aboutConfigEnabled` en release et passe
  `media.autoplay.default` à `0` via `about:config`.
- **Picture-in-Picture** : voir la sous-section dédiée ci-dessus — le PiP vidéo
  se met en pause (limite GeckoView assumée), la promotion CSS a été désactivée.
- **Pas de sauvegarde** : `allowBackup="false"` volontairement — le profil Gecko
  contient tes cookies de session Google, on ne veut pas qu'ils partent sur
  Google Drive. Corollaire : changer de téléphone = se reconnecter.
- **Pas de sync avec l'app YouTube officielle** : historique, « À regarder plus
  tard » et abonnements sont ceux de ton compte Google, donc partagés — mais les
  téléchargements hors-ligne de YouTube Premium ne sont pas accessibles.

---

## 10. Aspects légaux

À lire, ce n'est pas une formalité.

- **Cette solution contourne les Conditions Générales d'Utilisation de
  YouTube.** Les CGU interdisent explicitement d'accéder au service par un
  moyen autre que l'interface officielle, et d'interférer avec les publicités.
  Utiliser ce projet est une violation contractuelle de ces CGU.
- **Risque sur ton compte Google.** Google peut, en théorie, restreindre ou
  suspendre un compte utilisé de cette façon. C'est rare en pratique, mais ce
  n'est pas nul. Si ton compte Google est important pour toi, pèse le risque.
- **Usage strictement personnel.** Ce projet n'est pas destiné à être publié sur
  le Play Store, ni distribué, ni monétisé. Il ne le pourrait d'ailleurs pas :
  les règles du Play Store interdisent les apps qui altèrent le fonctionnement
  d'un service tiers.
- **Marque.** L'app n'utilise ni le nom, ni le logo, ni les couleurs de YouTube
  — d'où « TubeGuard » et une icône maison. Ne remets pas le logo officiel : ce
  serait une contrefaçon de marque, ce qui est un problème d'une autre nature
  qu'une violation de CGU.
- **uBlock Origin** est distribué sous licence **GPLv3**. Si tu actives le
  Plan A, tu embarques du code GPLv3 dans ton APK — sans conséquence tant que tu
  ne distribues rien, mais ça en aurait si tu partageais l'APK.
- **EasyList** est sous double licence **GPLv3 / CC BY-SA 3.0**.
- Les créateurs que tu regardes sont rémunérés par la publicité. Un abonnement
  YouTube Premium reste la façon de les soutenir sans pub.
