package dev.stefan.tubeguard

import android.graphics.Bitmap
import android.util.Log
import org.mozilla.geckoview.MediaSession

/**
 * Pont entre la `MediaSession` **de GeckoView** (l'état réel du lecteur YouTube
 * dans la page web) et la `MediaSessionCompat` **d'Android** (ce que voient
 * l'écran de verrouillage, la notification, les boutons du casque).
 *
 * GeckoView expose l'API Media Session du W3C : quand YouTube appelle
 * `navigator.mediaSession.setMetadata(...)` / joue une vidéo, GeckoView nous
 * notifie via [MediaSession.Delegate]. On recopie ces infos ici, et
 * [PlaybackService] les traduit en notification Android.
 *
 * Le trajet inverse (appui sur « Play » dans la notification) passe par
 * [play] / [pause] / … qui pilotent le lecteur web.
 */
object MediaBridge {

    private const val TAG = "TubeGuard.Media"

    interface Listener {
        fun onMediaStateChanged()
    }

    /** La MediaSession web active, ou null si aucune vidéo n'est chargée. */
    @Volatile
    private var geckoSession: MediaSession? = null

    @Volatile
    var isActive: Boolean = false
        private set

    @Volatile
    var isPlaying: Boolean = false
        private set

    @Volatile
    var title: String = ""
        private set

    @Volatile
    var artist: String = ""
        private set

    @Volatile
    var artwork: Bitmap? = null
        private set

    /** Durée en millisecondes, ou -1 si inconnue (direct / non renseignée). */
    @Volatile
    var durationMs: Long = -1L
        private set

    @Volatile
    var positionMs: Long = 0L
        private set

    @Volatile
    var playbackRate: Float = 1f
        private set

    /** Bitmasque des fonctions supportées ([MediaSession.Feature]). */
    @Volatile
    var features: Long = 0L
        private set

    private val listeners = mutableSetOf<Listener>()

    /**
     * Règle appliquée partout ici : on ne notifie JAMAIS un listener en tenant
     * le verrou. Les callbacks démarrent ou arrêtent le service de lecture, et
     * un jour l'un d'eux rappellera [addListener] ou [removeListener] — ce qui
     * partirait en interblocage si le verrou était encore tenu. On se contente
     * donc de copier la liste sous verrou, et on notifie en dehors.
     */
    fun addListener(l: Listener) {
        synchronized(this) { listeners += l }
        l.onMediaStateChanged()
    }

    fun removeListener(l: Listener) {
        synchronized(this) { listeners -= l }
    }

    private fun notifyChanged() {
        val snapshot = synchronized(this) { listeners.toList() }
        snapshot.forEach {
            runCatching { it.onMediaStateChanged() }
                .onFailure { e -> Log.w(TAG, "Listener en erreur", e) }
        }
    }

    // ------------------------------------------------------------------
    // Entrées : appelées par le MediaSession.Delegate dans MainActivity
    // ------------------------------------------------------------------

    fun onActivated(session: MediaSession) {
        geckoSession = session
        isActive = true
        notifyChanged()
    }

    fun onDeactivated() {
        geckoSession = null
        isActive = false
        isPlaying = false
        artwork = null
        durationMs = -1L
        positionMs = 0L
        notifyChanged()
    }

    fun onPlaybackStateChanged(playing: Boolean) {
        isPlaying = playing
        notifyChanged()
    }

    fun onMetadata(newTitle: String?, newArtist: String?) {
        title = newTitle?.takeIf { it.isNotBlank() } ?: "Vidéo"
        artist = newArtist?.takeIf { it.isNotBlank() } ?: "TubeGuard"
        notifyChanged()
    }

    fun onArtwork(bitmap: Bitmap?) {
        artwork = bitmap
        notifyChanged()
    }

    fun onPositionState(state: MediaSession.PositionState?) {
        if (state == null) return
        // GeckoView exprime les durées en secondes (double).
        durationMs = if (state.duration.isFinite() && state.duration > 0) {
            (state.duration * 1000.0).toLong()
        } else {
            -1L
        }
        positionMs = (state.position * 1000.0).toLong().coerceAtLeast(0L)
        playbackRate = state.playbackRate.toFloat().takeIf { it > 0f } ?: 1f
        notifyChanged()
    }

    fun onFeatures(newFeatures: Long) {
        features = newFeatures
        notifyChanged()
    }

    fun supports(feature: Long): Boolean = (features and feature) != 0L

    // ------------------------------------------------------------------
    // Sorties : commandes venues de la notification / du casque
    // ------------------------------------------------------------------

    // Play / pause / stop sont d'abord annoncés au content script : en PiP ou
    // en arrière-plan il ignore les pauses venant de la page, et doit savoir
    // que celle-ci vient de l'utilisateur pour la laisser passer.
    fun play() {
        NativeBridge.userPlay()
        geckoSession?.play()
    }

    fun pause() {
        NativeBridge.userPause()
        geckoSession?.pause()
    }

    fun stop() {
        NativeBridge.userPause()
        geckoSession?.stop()
    }

    fun next() = geckoSession?.nextTrack()
    fun previous() = geckoSession?.previousTrack()
    fun seekForward() = geckoSession?.seekForward()
    fun seekBackward() = geckoSession?.seekBackward()

    /** @param positionMs position absolue en millisecondes. */
    fun seekTo(positionMs: Long) {
        geckoSession?.seekTo(positionMs / 1000.0, /* fast = */ false)
    }
}
