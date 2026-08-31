package dev.stefan.tubeguard

import android.content.Context
import android.util.Log
import org.mozilla.geckoview.ContentBlocking
import org.mozilla.geckoview.GeckoRuntime
import org.mozilla.geckoview.GeckoRuntimeSettings
import org.mozilla.geckoview.GeckoSession
import org.mozilla.geckoview.GeckoSessionSettings
import java.io.File

/**
 * Détenteur unique du moteur Firefox et de la session de navigation.
 *
 * ## Persistance de session (exigence n°3)
 * Deux mécanismes indépendants, tous les deux nécessaires :
 *
 *  1. **Le profil Gecko** — cookies, localStorage, IndexedDB, cache. GeckoView
 *     crée par défaut un profil persistant dans le répertoire privé de l'app
 *     (`/data/data/dev.stefan.tubeguard/files/mozilla/`) tant que la session
 *     n'est PAS en mode privé. C'est ce qui te garde connecté à ton compte
 *     Google d'un lancement à l'autre. Rien à faire, sinon ne jamais activer
 *     `usePrivateMode(true)` et ne jamais appeler `StorageController.clearData()`.
 *
 *  2. **L'état de session** — l'onglet courant + son historique de navigation.
 *     Ce n'est PAS sauvegardé automatiquement : on sérialise le
 *     [GeckoSession.SessionState] dans un fichier à chaque changement, et on le
 *     restaure au démarrage. Voir [saveState] / [loadSavedState].
 */
object GeckoEngine {

    private const val TAG = "TubeGuard.Engine"
    private const val SESSION_STATE_FILE = "session_state.json"

    /** Page d'accueil. m.youtube.com = interface mobile, plus légère et tactile. */
    const val HOME_URL = "https://m.youtube.com/"

    @Volatile
    private var runtimeRef: GeckoRuntime? = null

    @Volatile
    private var sessionRef: GeckoSession? = null

    /** Dernier état de session connu, prêt à être écrit sur disque. */
    @Volatile
    private var lastSessionState: GeckoSession.SessionState? = null

    // ------------------------------------------------------------------
    // Runtime
    // ------------------------------------------------------------------

    fun runtime(context: Context): GeckoRuntime {
        runtimeRef?.let { return it }
        synchronized(this) {
            runtimeRef?.let { return it }
            val created = createRuntime(context.applicationContext)
            runtimeRef = created
            return created
        }
    }

    private fun createRuntime(appContext: Context): GeckoRuntime {
        // Protection anti-pistage native de Firefox. Elle ne remplace PAS le
        // bloqueur de pub (elle ne touche pas aux pubs servies par YouTube
        // lui-même, en first-party), mais elle élimine gratuitement les
        // traceurs tiers et allège les pages.
        val contentBlocking = ContentBlocking.Settings.Builder()
            .antiTracking(
                ContentBlocking.AntiTracking.AD or
                    ContentBlocking.AntiTracking.ANALYTIC or
                    ContentBlocking.AntiTracking.SOCIAL or
                    ContentBlocking.AntiTracking.CRYPTOMINING or
                    ContentBlocking.AntiTracking.FINGERPRINTING
            )
            .safeBrowsing(ContentBlocking.SafeBrowsing.DEFAULT)
            // ACCEPT_NON_TRACKERS = comportement par défaut de Firefox : les
            // cookies first-party (donc ceux de ta session Google) sont
            // conservés, seuls les cookies de traceurs tiers sont rejetés.
            //
            // Si tu rencontres des problèmes de connexion à ton compte Google,
            // bascule temporairement sur ContentBlocking.CookieBehavior.ACCEPT_ALL.
            .cookieBehavior(ContentBlocking.CookieBehavior.ACCEPT_NON_TRACKERS)
            .enhancedTrackingProtectionLevel(ContentBlocking.EtpLevel.DEFAULT)
            .build()

        val settings = GeckoRuntimeSettings.Builder()
            .contentBlocking(contentBlocking)
            .javaScriptEnabled(true)
            .aboutConfigEnabled(BuildConfig.DEBUG)
            .consoleOutput(BuildConfig.DEBUG)
            // Permet de brancher les devtools Firefox du PC sur l'app :
            //   adb forward tcp:6000 localfilesystem:/data/data/dev.stefan.tubeguard/firefox-debugger-socket
            // puis about:debugging dans Firefox desktop. Très utile pour déboguer
            // les content scripts du bloqueur de pub.
            .remoteDebuggingEnabled(BuildConfig.DEBUG)
            .preferredColorScheme(GeckoRuntimeSettings.COLOR_SCHEME_SYSTEM)
            .build()

        return GeckoRuntime.create(appContext, settings).also {
            Log.i(TAG, "GeckoRuntime créé")
        }
    }

    // ------------------------------------------------------------------
    // Session
    // ------------------------------------------------------------------

    fun session(context: Context): GeckoSession {
        sessionRef?.let { return it }
        synchronized(this) {
            sessionRef?.let { return it }

            val settings = GeckoSessionSettings.Builder()
                // usePrivateMode(false) : indispensable pour la persistance des
                // cookies. En mode privé, tout est effacé à la fermeture.
                .usePrivateMode(false)
                .useTrackingProtection(true)
                .userAgentMode(GeckoSessionSettings.USER_AGENT_MODE_MOBILE)
                .viewportMode(GeckoSessionSettings.VIEWPORT_MODE_MOBILE)
                .allowJavascript(true)
                .build()

            val created = GeckoSession(settings)
            created.open(runtime(context))
            sessionRef = created
            return created
        }
    }

    // ------------------------------------------------------------------
    // Sauvegarde / restauration de l'onglet
    // ------------------------------------------------------------------

    /** Appelé depuis `ProgressDelegate.onSessionStateChange`. */
    fun rememberState(state: GeckoSession.SessionState) {
        lastSessionState = state
    }

    /** Dernier état connu en mémoire, pour restaurer après un crash de contenu. */
    fun lastKnownState(): GeckoSession.SessionState? = lastSessionState

    /** Écrit l'état courant sur disque. Appelé dans `onStop()` de l'Activity. */
    fun saveState(context: Context) {
        val state = lastSessionState ?: return
        try {
            // SessionState.toString() est annoté @Nullable côté GeckoView : il
            // renvoie null si la sérialisation JSON interne échoue. On ne veut
            // surtout pas écrire la chaîne "null" dans le fichier, elle serait
            // relue comme un état corrompu au prochain lancement.
            val serialized = state.toString() ?: return
            File(context.filesDir, SESSION_STATE_FILE).writeText(serialized)
        } catch (e: Exception) {
            Log.w(TAG, "Impossible de sauvegarder l'état de session", e)
        }
    }

    /** Relit l'état sauvegardé, ou null si absent / illisible. */
    fun loadSavedState(context: Context): GeckoSession.SessionState? {
        val file = File(context.filesDir, SESSION_STATE_FILE)
        if (!file.exists()) return null
        return try {
            GeckoSession.SessionState.fromString(file.readText())
        } catch (e: Exception) {
            Log.w(TAG, "État de session corrompu, on repart de la page d'accueil", e)
            file.delete()
            null
        }
    }
}
