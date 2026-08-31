package dev.stefan.tubeguard

import android.app.Application
import android.os.Build
import android.util.Log
import java.io.File

/**
 * Point d'entrée du process.
 *
 * On initialise le [GeckoRuntime] ici (et pas dans l'Activity) pour deux raisons :
 *  - le runtime doit être un singleton pour tout le process, sinon GeckoView lève
 *    une IllegalStateException au deuxième `GeckoRuntime.create()` ;
 *  - le démarrage du moteur (~300 ms) est ainsi absorbé pendant l'affichage du
 *    splash système au lieu de retarder le premier paint.
 *
 * ⚠️ GARDE-FOU MULTI-PROCESS — indispensable.
 * GeckoView fait tourner son moteur dans des **process enfants isolés** (un pour
 * le GPU, un par onglet de contenu : `:gpu_…`, `:tab_…`). Android ré-instancie
 * CETTE classe `Application` dans chacun d'eux. Si on y (ré)initialise un
 * GeckoRuntime, le process enfant plante immédiatement et entraîne le crash de
 * toute l'app — symptôme observé : écran blanc puis fermeture, sans exception
 * Java (c'est un abort natif). On ne s'initialise donc QUE dans le process
 * principal ; dans les process enfants, `onCreate` se contente de rendre la main
 * et GeckoView gère leur cycle de vie lui-même.
 */
class TubeGuardApp : Application() {

    override fun onCreate() {
        super.onCreate()

        val process = currentProcessName()
        if (!isMainProcess(process)) {
            Log.i(TAG, "Process enfant GeckoView ($process) — pas d'initialisation applicative")
            return
        }

        Log.i(TAG, "Démarrage — initialisation du runtime GeckoView")

        val runtime = GeckoEngine.runtime(this)

        // Installation du bloqueur de pub. Asynchrone : la navigation peut
        // commencer avant que l'extension soit prête, GeckoView l'appliquera
        // dès qu'elle sera enregistrée.
        AdBlock.install(this, runtime)

        // Canal natif app ↔ content script (utilisé pour le Picture-in-Picture).
        // On le branche ici, au niveau du process, et non dans l'Activity : le
        // délégué se pose sur la session (un singleton de GeckoEngine), une seule
        // fois suffit, et ça évite de faire fuir l'Activity via un callback
        // jamais retiré (voir le commentaire dans MainActivity.onCreate).
        AdBlock.onYtblockReady { extension ->
            runCatching { NativeBridge.attach(GeckoEngine.session(this), extension) }
                .onFailure { Log.w(TAG, "Canal natif indisponible", it) }
        }
    }

    /**
     * Le process principal porte exactement l'applicationId ; les process
     * enfants de GeckoView y ajoutent un suffixe `:quelquechose`.
     */
    private fun isMainProcess(process: String?): Boolean =
        process == null || process == packageName

    private fun currentProcessName(): String? {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            return getProcessName()
        }
        // API 26-27 : pas de getProcessName(), on lit la ligne de commande du
        // process. Les octets sont séparés/terminés par des NUL.
        return try {
            File("/proc/self/cmdline").readText().takeWhile { it != '\u0000' && it != ' ' }.trim().ifEmpty { null }
        } catch (e: Exception) {
            null
        }
    }

    companion object {
        const val TAG = "TubeGuard"
    }
}
