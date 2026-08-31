package dev.stefan.tubeguard

import android.util.Log
import org.json.JSONObject
import org.mozilla.geckoview.GeckoSession
import org.mozilla.geckoview.WebExtension

/**
 * Canal de messagerie natif entre l'app Kotlin et le content script de
 * l'extension maison.
 *
 * Côté JS, le content script ouvre le canal avec :
 *     const port = browser.runtime.connectNative("browser");
 * Côté Kotlin, on enregistre un [WebExtension.MessageDelegate] sur la session
 * pour le même nom d'« application native » (`browser`).
 *
 * À quoi ça sert concrètement ?
 *
 *  - **Picture-in-Picture propre.** Le PiP d'Android duplique le contenu de la
 *    fenêtre de l'Activity. Comme l'Activity n'affiche qu'un GeckoView plein
 *    écran, la vignette PiP montrerait toute la page YouTube (barre de
 *    recherche, commentaires…) au lieu de la seule vidéo. On demande donc au
 *    content script de mettre l'élément `<video>` en plein écran HTML juste
 *    avant d'entrer en PiP : la vignette ne contient alors que la vidéo.
 *
 * Le délégué est posé sur la SESSION : GeckoView n'y délivre que les ports
 * ouverts par les content scripts (le background script, lui, exigerait un
 * délégué d'extension). C'est exactement ce qu'on veut ici — seul le content
 * script a besoin de parler à l'app.
 */
object NativeBridge {

    private const val TAG = "TubeGuard.Bridge"

    /** Nom d'app native ; doit correspondre à `connectNative("browser")` côté JS. */
    private const val NATIVE_APP = "browser"

    @Volatile
    private var port: WebExtension.Port? = null

    /**
     * À appeler une fois la session ouverte ET l'extension maison installée.
     * Sans effet si le Plan A (uBlock Origin) est actif : uBO n'ouvre évidemment
     * pas de canal `connectNative` vers nous.
     */
    fun attach(session: GeckoSession, extension: WebExtension) {
        session.webExtensionController.setMessageDelegate(
            extension,
            object : WebExtension.MessageDelegate {

                override fun onConnect(newPort: WebExtension.Port) {
                    Log.i(TAG, "Content script connecté (port ouvert)")
                    port = newPort
                    newPort.setDelegate(object : WebExtension.PortDelegate {
                        override fun onPortMessage(message: Any, p: WebExtension.Port) {
                            handleMessage(message)
                        }

                        override fun onDisconnect(p: WebExtension.Port) {
                            if (port === p) port = null
                        }
                    })
                }

                // Messages ponctuels (browser.runtime.sendNativeMessage).
                override fun onMessage(
                    nativeApp: String,
                    message: Any,
                    sender: WebExtension.MessageSender
                ): org.mozilla.geckoview.GeckoResult<Any>? {
                    handleMessage(message)
                    return null
                }
            },
            NATIVE_APP
        )
    }

    private fun handleMessage(message: Any) {
        val json = message as? JSONObject ?: return
        when (json.optString("event")) {
            "adSkipped" -> Log.d(TAG, "Coupure pub sautée dans le lecteur")
            "ready" -> Log.i(TAG, "Content script prêt sur ${json.optString("url")}")
            "guard" -> Log.i(TAG, "GUARD: ${json.optString("state")} (paused=${json.optBoolean("paused")})")
        }
    }

    /** Demande au content script de passer la vidéo en plein écran HTML. */
    fun requestVideoFullscreen() = send("enterVideoFullscreen")

    /** Sort du plein écran HTML. */
    fun exitVideoFullscreen() = send("exitVideoFullscreen")

    /** Demande de maintenir la lecture (arrière-plan écran éteint). */
    fun keepPlaying() = send("keepPlaying")

    /** Relâche le maintien de lecture (retour au premier plan). */
    fun releasePlaying() = send("releasePlaying")

    private fun send(cmd: String) {
        val p = port
        if (p == null) {
            Log.w(TAG, "send('$cmd') IGNORÉ : aucun port connecté")
            return
        }
        try {
            p.postMessage(JSONObject().put("cmd", cmd))
            Log.i(TAG, "send('$cmd') envoyé")
        } catch (e: Exception) {
            Log.w(TAG, "Envoi '$cmd' impossible", e)
            port = null
        }
    }
}
