package dev.stefan.tubeguard

import android.content.Context
import android.util.Log
import org.mozilla.geckoview.GeckoRuntime
import org.mozilla.geckoview.WebExtension
import java.io.IOException

/**
 * Installation du bloqueur de publicités.
 *
 * ============================================================================
 *  PLAN A — uBlock Origin embarqué comme extension "builtIn"
 * ============================================================================
 * On dépose uBlock Origin **décompressé** dans
 * `app/src/main/assets/extensions/ublock/` (voir le README de ce dossier) et on
 * l'enregistre via [org.mozilla.geckoview.WebExtensionController.ensureBuiltIn].
 *
 * ⚠️ AVERTISSEMENT — CE PLAN A DE FORTES CHANCES D'ÉCHOUER.
 * Les extensions « builtIn » de GeckoView sont chargées avec un jeu de
 * permissions restreint. Le `manifest.json` d'uBlock Origin déclare des
 * permissions qui sont régulièrement refusées dans ce contexte :
 *   - `webRequestBlocking` (refusée hors extensions privilégiées / signées),
 *   - `menus` / `contextMenus`, `privacy`, `browsingData`, `unlimitedStorage`,
 *   - la déclaration `background.persistent` et, sur uBO ≥ 1.60, le passage
 *     partiel à MV3 avec `declarative_net_request` + `host_permissions`.
 * L'installation échoue alors avec une erreur du type
 * `ERROR_CORRUPT_FILE` / `Extension is invalid` / `permission not allowed`.
 * Le message d'erreur exact est loggé en clair (tag "TubeGuard.AdBlock").
 *
 * ============================================================================
 *  PLAN B — extension maison minimaliste (**ACTIVE PAR DÉFAUT**)
 * ============================================================================
 * Extension MV2 écrite pour ce projet, dans
 * `app/src/main/assets/extensions/ytblock/`. Elle reprend les deux mécanismes
 * d'uBlock Origin :
 *   1. **Blocage réseau** : `webRequest.onBeforeRequest` en mode "blocking",
 *      alimenté par un moteur de filtres au format Adblock Plus (sous-ensemble)
 *      qui lit EasyList + une liste spécifique YouTube.
 *   2. **Filtrage cosmétique + anti-pré/mid-roll** : une feuille de style qui
 *      masque les emplacements publicitaires, et un content script qui détecte
 *      les coupures pub dans le lecteur et les saute.
 * Elle ne déclare que des permissions acceptées par GeckoView en builtIn, donc
 * elle s'installe de façon fiable.
 *
 * ============================================================================
 *  CHOISIR LA STRATÉGIE : modifie la constante [STRATEGY] ci-dessous.
 * ============================================================================
 */
object AdBlock {

    private const val TAG = "TubeGuard.AdBlock"

    enum class Strategy {
        /** Uniquement uBlock Origin. Si ça échoue → aucun blocage. */
        PLAN_A_ONLY,

        /** Tente uBlock Origin ; en cas d'échec, bascule sur l'extension maison. */
        PLAN_A_THEN_B,

        /** Uniquement l'extension maison. */
        PLAN_B_ONLY,
    }

    // >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>
    //  STRATÉGIE ACTIVE PAR DÉFAUT : PLAN B (extension maison "ytblock").
    //
    //  Raison : c'est la seule des deux qui fonctionne de façon reproductible,
    //  et le dossier assets/extensions/ublock/ est livré VIDE (je ne peux pas
    //  redistribuer le code d'uBlock Origin ici).
    //
    //  Pour tester le Plan A : dépose uBO décompressé dans
    //  assets/extensions/ublock/ puis passe cette constante à PLAN_A_THEN_B.
    // >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>
    val STRATEGY: Strategy = Strategy.PLAN_B_ONLY

    // --- Plan A ---------------------------------------------------------
    /** ID déclaré dans le manifest.json d'uBlock Origin — ne pas modifier. */
    private const val UBO_ID = "uBlock0@raymondhill.net"
    private const val UBO_ASSET_DIR = "extensions/ublock"
    private const val UBO_URI = "resource://android/assets/extensions/ublock/"

    // --- Plan B ---------------------------------------------------------
    /** Doit correspondre à `browser_specific_settings.gecko.id` du manifest. */
    const val YTBLOCK_ID = "ytblock@tubeguard.local"
    private const val YTBLOCK_ASSET_DIR = "extensions/ytblock"
    private const val YTBLOCK_URI = "resource://android/assets/extensions/ytblock/"

    /**
     * L'extension maison une fois installée. On en a besoin pour brancher le
     * canal de messagerie natif (voir [NativeBridge]).
     */
    @Volatile
    var ytblockExtension: WebExtension? = null
        private set

    private val readyCallbacks = mutableListOf<(WebExtension) -> Unit>()

    /**
     * S'abonne à l'installation de l'extension maison.
     * Le callback est appelé immédiatement si elle est déjà prête.
     */
    @Synchronized
    fun onYtblockReady(callback: (WebExtension) -> Unit) {
        val ext = ytblockExtension
        if (ext != null) callback(ext) else readyCallbacks += callback
    }

    @Synchronized
    private fun publishYtblock(extension: WebExtension) {
        ytblockExtension = extension
        readyCallbacks.forEach { it(extension) }
        readyCallbacks.clear()
    }

    // ------------------------------------------------------------------

    fun install(context: Context, runtime: GeckoRuntime) {
        when (STRATEGY) {
            Strategy.PLAN_A_ONLY -> installUBlock(context, runtime, fallbackToPlanB = false)
            Strategy.PLAN_A_THEN_B -> installUBlock(context, runtime, fallbackToPlanB = true)
            Strategy.PLAN_B_ONLY -> installYtblock(context, runtime)
        }
    }

    // ------------------------------------------------------------------
    // PLAN A
    // ------------------------------------------------------------------

    private fun installUBlock(context: Context, runtime: GeckoRuntime, fallbackToPlanB: Boolean) {
        if (!assetDirContainsManifest(context, UBO_ASSET_DIR)) {
            Log.e(
                TAG,
                "PLAN A impossible : aucun manifest.json dans assets/$UBO_ASSET_DIR/. " +
                    "Décompresse le .xpi d'uBlock Origin dans ce dossier " +
                    "(voir assets/extensions/ublock/LISEZ-MOI.txt)."
            )
            if (fallbackToPlanB) installYtblock(context, runtime)
            return
        }

        Log.i(TAG, "PLAN A : tentative ensureBuiltIn() sur uBlock Origin…")

        runtime.webExtensionController
            .ensureBuiltIn(UBO_URI, UBO_ID)
            .accept(
                { extension ->
                    Log.i(
                        TAG,
                        "PLAN A OK — uBlock Origin installé " +
                            "(${extension?.metaData?.name} v${extension?.metaData?.version})"
                    )
                },
                { error ->
                    // C'est ICI qu'on atterrit si le manifest est rejeté.
                    Log.e(TAG, "PLAN A ÉCHOUÉ — GeckoView a refusé uBlock Origin : ${error?.message}", error)
                    if (fallbackToPlanB) {
                        Log.w(TAG, "Bascule automatique sur le PLAN B (extension maison).")
                        installYtblock(context, runtime)
                    } else {
                        Log.e(TAG, "STRATEGY = PLAN_A_ONLY : aucun blocage de pub actif.")
                    }
                }
            )
    }

    // ------------------------------------------------------------------
    // PLAN B
    // ------------------------------------------------------------------

    private fun installYtblock(context: Context, runtime: GeckoRuntime) {
        if (!assetDirContainsManifest(context, YTBLOCK_ASSET_DIR)) {
            Log.e(TAG, "PLAN B impossible : assets/$YTBLOCK_ASSET_DIR/manifest.json introuvable.")
            return
        }

        Log.i(TAG, "PLAN B : installation de l'extension maison 'ytblock'…")

        runtime.webExtensionController
            .ensureBuiltIn(YTBLOCK_URI, YTBLOCK_ID)
            .accept(
                { extension ->
                    if (extension == null) {
                        Log.e(TAG, "PLAN B : extension nulle (cas anormal).")
                        return@accept
                    }
                    Log.i(
                        TAG,
                        "PLAN B OK — ${extension.metaData.name} v${extension.metaData.version} actif"
                    )
                    publishYtblock(extension)
                },
                { error ->
                    Log.e(TAG, "PLAN B ÉCHOUÉ : ${error?.message}", error)
                }
            )
    }

    // ------------------------------------------------------------------

    /** Vérifie qu'un dossier d'assets contient bien un manifest.json à sa racine. */
    private fun assetDirContainsManifest(context: Context, dir: String): Boolean = try {
        context.assets.open("$dir/manifest.json").close()
        true
    } catch (e: IOException) {
        false
    }
}
