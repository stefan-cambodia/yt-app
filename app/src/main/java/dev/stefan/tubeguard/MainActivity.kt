package dev.stefan.tubeguard

import android.Manifest
import android.app.PictureInPictureParams
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.util.Log
import android.util.Rational
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import dev.stefan.tubeguard.databinding.ActivityMainBinding
import org.mozilla.geckoview.AllowOrDeny
import org.mozilla.geckoview.GeckoResult
import org.mozilla.geckoview.GeckoSession
import org.mozilla.geckoview.MediaSession

/**
 * L'unique Activity de l'app : un GeckoView plein écran, sans barre d'adresse
 * ni aucun chrome de navigateur (exigence n°1).
 */
class MainActivity : androidx.activity.ComponentActivity(), MediaBridge.Listener {

    private lateinit var binding: ActivityMainBinding
    private lateinit var session: GeckoSession

    /** Mis à jour par le NavigationDelegate ; pilote le bouton retour. */
    private var canGoBack = false

    /** true quand la page a demandé le plein écran HTML (vidéo en grand). */
    private var isHtmlFullscreen = false

    /** true quand c'est NOUS qui avons forcé le plein écran pour le PiP. */
    private var fullscreenForcedForPip = false

    private var isInPip = false

    // ------------------------------------------------------------------
    // Cycle de vie
    // ------------------------------------------------------------------

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        binding = ActivityMainBinding.inflate(layoutInflater)
        setContentView(binding.root)

        applyImmersiveMode()
        requestNotificationPermissionIfNeeded()

        session = GeckoEngine.session(this)
        wireDelegates()

        binding.geckoView.setSession(session)

        // NB : le branchement du canal natif (NativeBridge.attach) est fait une
        // fois pour toutes dans TubeGuardApp, PAS ici. L'y mettre ferait fuir
        // l'Activity : le callback onYtblockReady capture `this` et n'est jamais
        // retiré, or il n'est purgé qu'à l'installation réussie de l'extension —
        // chaque recréation d'Activity (rotation, thème…) laisserait une fuite
        // si l'installation avait échoué.

        MediaBridge.addListener(this)
        setupBackNavigation()

        // Ordre de priorité pour la page à afficher :
        //   1. un lien YouTube passé par intent (clic sur un lien ailleurs)
        //   2. l'état de session sauvegardé au dernier lancement
        //   3. la page d'accueil
        val urlFromIntent = extractYouTubeUrl(intent)
        when {
            urlFromIntent != null -> session.loadUri(urlFromIntent)
            else -> {
                val saved = GeckoEngine.loadSavedState(this)
                if (saved != null) session.restoreState(saved) else session.loadUri(GeckoEngine.HOME_URL)
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        extractYouTubeUrl(intent)?.let {
            Log.i(TAG, "Ouverture d'un lien entrant : $it")
            session.loadUri(it)
        }
    }

    override fun onResume() {
        super.onResume()
        applyImmersiveMode()
    }

    override fun onStop() {
        super.onStop()
        // On sauvegarde ici plutôt que dans onDestroy : onDestroy n'est pas
        // garanti d'être appelé si le système tue le process.
        GeckoEngine.saveState(this)
    }

    override fun onDestroy() {
        MediaBridge.removeListener(this)
        // On détache la vue SANS fermer la session : le moteur continue de
        // décoder l'audio en arrière-plan (c'est tout l'intérêt du couple
        // session persistante + service foreground).
        binding.geckoView.releaseSession()
        if (isFinishing) PlaybackService.stop(this)
        super.onDestroy()
    }

    // ------------------------------------------------------------------
    // Délégués GeckoView
    // ------------------------------------------------------------------

    private fun wireDelegates() {

        // --- Navigation : bouton retour + confinement au domaine YouTube ---
        session.navigationDelegate = object : GeckoSession.NavigationDelegate {

            override fun onCanGoBack(session: GeckoSession, value: Boolean) {
                canGoBack = value
            }

            override fun onLoadRequest(
                session: GeckoSession,
                request: GeckoSession.NavigationDelegate.LoadRequest
            ): GeckoResult<AllowOrDeny> {
                val uri = Uri.parse(request.uri)
                val host = uri.host
                return when {
                    // about:blank, blob:, data:… (générés par le lecteur) : pas
                    // d'hôte, on les garde dans l'app. Les renvoyer au navigateur
                    // système via ACTION_VIEW n'aurait aucun sens.
                    host == null -> GeckoResult.allow()
                    isInternalHost(host) -> GeckoResult.allow()
                    else -> {
                        // Un lien externe (description de vidéo, sponsor…) est
                        // ouvert dans le vrai navigateur : l'app reste une app
                        // YouTube, pas un navigateur généraliste.
                        openExternally(request.uri)
                        GeckoResult.deny()
                    }
                }
            }

            override fun onNewSession(
                session: GeckoSession,
                uri: String
            ): GeckoResult<GeckoSession>? {
                // target="_blank" : on charge dans la session courante plutôt
                // que d'ouvrir un « onglet » qu'on n'a pas d'UI pour afficher.
                if (isInternalHost(Uri.parse(uri).host)) {
                    session.loadUri(uri)
                } else {
                    openExternally(uri)
                }
                // null = « je ne veux pas de nouvelle session », la navigation
                // est abandonnée côté moteur.
                return null
            }
        }

        // --- Progression : sauvegarde de l'onglet ---
        session.progressDelegate = object : GeckoSession.ProgressDelegate {
            override fun onSessionStateChange(session: GeckoSession, state: GeckoSession.SessionState) {
                GeckoEngine.rememberState(state)
            }
        }

        // --- Contenu : plein écran HTML, crash du process de contenu ---
        session.contentDelegate = object : GeckoSession.ContentDelegate {

            override fun onFullScreen(session: GeckoSession, fullScreen: Boolean) {
                isHtmlFullscreen = fullScreen
                applyImmersiveMode()
                updatePipParams()
            }

            override fun onCrash(session: GeckoSession) {
                Log.e(TAG, "Le process de contenu a planté — restauration")
                recoverContentProcess(session)
            }

            override fun onKill(session: GeckoSession) {
                Log.w(TAG, "Process de contenu tué par le système — restauration")
                recoverContentProcess(session)
            }
        }

        // --- Média : alimente MediaBridge (notification + PiP + wake lock) ---
        session.mediaSessionDelegate = object : MediaSession.Delegate {

            override fun onActivated(session: GeckoSession, mediaSession: MediaSession) {
                MediaBridge.onActivated(mediaSession)
            }

            override fun onDeactivated(session: GeckoSession, mediaSession: MediaSession) {
                MediaBridge.onDeactivated()
            }

            override fun onPlay(session: GeckoSession, mediaSession: MediaSession) {
                MediaBridge.onPlaybackStateChanged(true)
            }

            override fun onPause(session: GeckoSession, mediaSession: MediaSession) {
                MediaBridge.onPlaybackStateChanged(false)
            }

            override fun onStop(session: GeckoSession, mediaSession: MediaSession) {
                MediaBridge.onPlaybackStateChanged(false)
            }

            override fun onFeatures(session: GeckoSession, mediaSession: MediaSession, features: Long) {
                MediaBridge.onFeatures(features)
            }

            override fun onPositionState(
                session: GeckoSession,
                mediaSession: MediaSession,
                state: MediaSession.PositionState
            ) {
                MediaBridge.onPositionState(state)
            }

            override fun onMetadata(
                session: GeckoSession,
                mediaSession: MediaSession,
                meta: MediaSession.Metadata
            ) {
                MediaBridge.onMetadata(meta.title, meta.artist)
                // La pochette est chargée en asynchrone : elle n'est pas
                // indispensable, on ignore silencieusement les échecs.
                meta.artwork?.getBitmap(ARTWORK_SIZE_PX)?.accept(
                    { bitmap -> MediaBridge.onArtwork(bitmap) },
                    { /* pas de pochette, tant pis */ }
                )
            }
        }
    }

    // ------------------------------------------------------------------
    // Bouton retour Android (exigence n°2)
    // ------------------------------------------------------------------

    private fun setupBackNavigation() {
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                when {
                    // 1. Sortir du plein écran vidéo
                    isHtmlFullscreen -> session.exitFullScreen()

                    // 2. Reculer dans l'historique GeckoView
                    canGoBack -> session.goBack()

                    // 3. Plus rien à faire : on met l'app en arrière-plan au
                    //    lieu de la fermer, pour ne pas couper l'audio ni
                    //    perdre l'état du lecteur.
                    else -> moveTaskToBack(true)
                }
            }
        })
    }

    // ------------------------------------------------------------------
    // Picture-in-Picture (exigence n°5)
    // ------------------------------------------------------------------

    private val pipSupported: Boolean
        get() = packageManager.hasSystemFeature(PackageManager.FEATURE_PICTURE_IN_PICTURE)

    override fun onUserLeaveHint() {
        super.onUserLeaveHint()
        // Appui sur Home / geste de retour à l'accueil pendant une lecture :
        // on bascule en vignette flottante.
        if (MediaBridge.isPlaying && pipSupported && !isInPip) {
            enterPip()
        }
    }

    private fun enterPip() {
        // La promotion du <video> est faite dans onPictureInPictureModeChanged,
        // pas ici : sur Android 12+, setAutoEnterEnabled fait entrer le système
        // en PiP tout seul sans passer par enterPip(), et il faut que les DEUX
        // chemins déclenchent la promotion. Ici on se contente de l'appel manuel
        // (indispensable sur Android 8-11 qui n'ont pas l'auto-enter).
        runCatching { enterPictureInPictureMode(buildPipParams()) }
            .onFailure { Log.w(TAG, "Entrée en PiP refusée", it) }
    }

    private fun buildPipParams(): PictureInPictureParams {
        val builder = PictureInPictureParams.Builder()
            // 16:9, la seule valeur qui a du sens pour YouTube. Android refuse
            // les ratios hors de [1:2.39, 2.39:1], donc pas besoin de clamper.
            .setAspectRatio(Rational(16, 9))

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            // Android 12+ : le système entre tout seul en PiP quand l'app passe
            // en arrière-plan, ce qui donne une transition bien plus fluide que
            // l'appel manuel dans onUserLeaveHint.
            builder.setAutoEnterEnabled(MediaBridge.isPlaying)
            builder.setSeamlessResizeEnabled(true)
        }
        return builder.build()
    }

    private fun updatePipParams() {
        if (!pipSupported) return
        runCatching { setPictureInPictureParams(buildPipParams()) }
    }

    override fun onPictureInPictureModeChanged(
        isInPictureInPictureMode: Boolean,
        newConfig: android.content.res.Configuration
    ) {
        super.onPictureInPictureModeChanged(isInPictureInPictureMode, newConfig)
        isInPip = isInPictureInPictureMode

        if (isInPictureInPictureMode) {
            // Entrée en PiP, quel qu'en soit le déclencheur (appel manuel OU
            // auto-enter système d'Android 12+). C'est le seul endroit commun
            // aux deux chemins : on y promeut le <video> pour que la vignette
            // ne montre que la vidéo, pas toute la page.
            if (!isHtmlFullscreen && !fullscreenForcedForPip) {
                NativeBridge.requestVideoFullscreen()
                fullscreenForcedForPip = true
            }
        } else {
            // Retour en plein écran d'app : on annule le plein écran HTML si
            // c'est nous qui l'avions forcé.
            if (fullscreenForcedForPip) {
                NativeBridge.exitVideoFullscreen()
                fullscreenForcedForPip = false
            }
            applyImmersiveMode()
        }
    }

    // ------------------------------------------------------------------
    // Lecture en arrière-plan (exigence n°6)
    // ------------------------------------------------------------------

    override fun onMediaStateChanged() {
        if (MediaBridge.isActive) {
            PlaybackService.start(this)
        }
        updatePipParams()
    }

    // ------------------------------------------------------------------
    // Immersif (exigence n°1)
    // ------------------------------------------------------------------

    /**
     * Masque barre de statut et barre de navigation.
     *
     * Passe [IMMERSIVE_ALWAYS] à `false` si tu préfères ne masquer les barres
     * système que pendant les vidéos en plein écran (l'heure et la batterie
     * restent alors visibles pendant la navigation).
     */
    private fun applyImmersiveMode() {
        val hide = IMMERSIVE_ALWAYS || isHtmlFullscreen || isInPip

        WindowCompat.setDecorFitsSystemWindows(window, !hide)
        val controller = WindowInsetsControllerCompat(window, window.decorView)
        controller.systemBarsBehavior =
            WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE

        if (hide) {
            controller.hide(WindowInsetsCompat.Type.systemBars())
        } else {
            controller.show(WindowInsetsCompat.Type.systemBars())
        }
    }

    // ------------------------------------------------------------------
    // Intents entrants (exigence n°4)
    // ------------------------------------------------------------------

    /**
     * Extrait une URL YouTube exploitable de l'intent reçu.
     * Gère `VIEW https://…`, `VIEW vnd.youtube:VIDEO_ID` et `SEND text/plain`.
     */
    private fun extractYouTubeUrl(intent: Intent?): String? {
        if (intent == null) return null

        val raw: String? = when (intent.action) {
            Intent.ACTION_VIEW -> intent.dataString
            Intent.ACTION_SEND -> intent.getStringExtra(Intent.EXTRA_TEXT)
                ?.let { Regex("""https?://\S+""").find(it)?.value }
                // Une phrase partagée (« Regarde ça : https://youtu.be/x ! »)
                // colle la ponctuation finale à l'URL via \S+. On rogne les
                // caractères qui ne peuvent pas terminer une URL.
                ?.trimEnd('.', ',', '!', '?', ')', ']', '}', '"', '\'', ';', ':')
            else -> null
        }

        return raw?.let { YouTubeLinks.normalize(it) }
    }

    /**
     * Après un crash/kill du process de contenu, on tente de rouvrir la page où
     * l'utilisateur en était (dernier SessionState connu) plutôt que de le jeter
     * sur la page d'accueil et lui faire perdre sa vidéo. Repli sur l'accueil si
     * aucun état n'est disponible.
     */
    private fun recoverContentProcess(session: GeckoSession) {
        val state = GeckoEngine.lastKnownState()
        if (state != null) session.restoreState(state) else session.loadUri(GeckoEngine.HOME_URL)
    }

    private fun openExternally(url: String) {
        runCatching {
            startActivity(
                Intent(Intent.ACTION_VIEW, Uri.parse(url))
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            )
        }.onFailure { Log.w(TAG, "Aucune app pour ouvrir $url", it) }
    }

    private fun isInternalHost(host: String?): Boolean = YouTubeLinks.isInternalHost(host)

    // ------------------------------------------------------------------

    private val notificationPermissionLauncher =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
            if (!granted) {
                Log.w(TAG, "Notification refusée : la lecture en arrière-plan sera instable.")
            }
        }

    private fun requestNotificationPermissionIfNeeded() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return
        val granted = ContextCompat.checkSelfPermission(
            this, Manifest.permission.POST_NOTIFICATIONS
        ) == PackageManager.PERMISSION_GRANTED
        if (!granted) {
            notificationPermissionLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
        }
    }

    companion object {
        private const val TAG = "TubeGuard.Main"
        private const val ARTWORK_SIZE_PX = 512

        /** Mode immersif permanent (cf. [applyImmersiveMode]). */
        private const val IMMERSIVE_ALWAYS = false
    }
}
