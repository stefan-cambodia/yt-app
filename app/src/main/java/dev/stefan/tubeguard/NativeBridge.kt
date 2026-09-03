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
 *  - **Picture-in-Picture.** On signale l'entrée/sortie de la vignette (cmd
 *    `pip`). Le content script y répond en promouvant le lecteur sur tout le
 *    viewport (la vignette Android recopie la fenêtre de l'Activity : sans ça
 *    elle montrerait toute la page) et en maintenant la lecture — il ignore
 *    les `pause()` que le lecteur YouTube tente de lui-même en PiP.
 *  - **Maintien de lecture écran éteint** (cmd `keepPlaying` / `releasePlaying`).
 *  - **Pause / lecture voulues par l'utilisateur** (cmd `userPause` /
 *    `userPlay`) : venant de la notification, du casque ou des contrôles de la
 *    vignette PiP, elles doivent passer MALGRÉ le maintien de lecture. L'app les
 *    annonce avant de piloter la MediaSession, pour que le content script les
 *    laisse passer.
 *
 *  Le canal est fragile à établir (voir le content script) : chaque commande a
 *  un repli autonome côté JS, et n'est jamais indispensable.
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

    /** Signale l'entrée (true) ou la sortie (false) du Picture-in-Picture. */
    fun pipChanged(inPip: Boolean) = send("pip", JSONObject().put("on", inPip))

    /** Demande de maintenir la lecture (arrière-plan écran éteint). */
    fun keepPlaying() = send("keepPlaying")

    /** Relâche le maintien de lecture (retour au premier plan). */
    fun releasePlaying() = send("releasePlaying")

    /** L'utilisateur a demandé la pause (notification, casque, vignette PiP). */
    fun userPause() = send("userPause")

    /** L'utilisateur a demandé la lecture. */
    fun userPlay() = send("userPlay")

    private fun send(cmd: String, message: JSONObject = JSONObject()) {
        val p = port
        if (p == null) {
            Log.w(TAG, "send('$cmd') IGNORÉ : aucun port connecté")
            return
        }
        try {
            p.postMessage(message.put("cmd", cmd))
            Log.i(TAG, "send('$cmd') envoyé")
        } catch (e: Exception) {
            Log.w(TAG, "Envoi '$cmd' impossible", e)
            port = null
        }
    }
}
