package dev.stefan.tubeguard

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import android.support.v4.media.MediaMetadataCompat
import android.support.v4.media.session.MediaSessionCompat
import android.support.v4.media.session.PlaybackStateCompat
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import androidx.media.session.MediaButtonReceiver

/**
 * Service *foreground* qui rend possible la lecture audio écran éteint
 * (exigence n°6).
 *
 * Pourquoi un service est indispensable :
 *  - GeckoView continue techniquement à décoder l'audio quand l'Activity passe
 *    en arrière-plan, MAIS sans composant foreground le système considère le
 *    process comme « cacheable » et peut le tuer à tout moment (et le fait très
 *    vite sur les surcouches type MIUI / OneUI / ColorOS) ;
 *  - Android 13+ interdit purement et simplement à un process en arrière-plan
 *    de conserver un wake lock utile sans notification visible ;
 *  - c'est ce qui alimente les contrôles de l'écran de verrouillage.
 *
 * Ce service ne lit rien lui-même : il reflète l'état de [MediaBridge] et
 * renvoie les commandes vers le lecteur web.
 */
class PlaybackService : Service(), MediaBridge.Listener {

    private lateinit var mediaSession: MediaSessionCompat
    private var wakeLock: PowerManager.WakeLock? = null
    private var startedForeground = false
    private var listenerRegistered = false

    override fun onCreate() {
        super.onCreate()
        createChannel()

        mediaSession = MediaSessionCompat(this, "TubeGuard").apply {
            setCallback(object : MediaSessionCompat.Callback() {
                override fun onPlay() { MediaBridge.play() }
                override fun onPause() { MediaBridge.pause() }
                override fun onStop() { MediaBridge.stop() }
                override fun onSkipToNext() { MediaBridge.next() }
                override fun onSkipToPrevious() { MediaBridge.previous() }
                override fun onFastForward() { MediaBridge.seekForward() }
                override fun onRewind() { MediaBridge.seekBackward() }
                override fun onSeekTo(pos: Long) { MediaBridge.seekTo(pos) }
            })
            isActive = true
        }

        val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
        wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "TubeGuard::playback").apply {
            setReferenceCounted(false)
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // ── Passage au premier plan AVANT toute autre chose ──────────────
        // Le service est démarré via startForegroundService() : le système
        // exige startForeground() dans les 5 secondes, sinon il tue le process
        // avec une ForegroundServiceDidNotStartInTimeException.
        //
        // C'est un piège réel ici : si la lecture s'est arrêtée entre le
        // démarrage du service et ce callback, la suite du code demande
        // l'arrêt immédiat. Sans le startForeground() ci-dessous, on
        // appellerait stopSelf() sans jamais être passé au premier plan —
        // et Android considère ça comme une violation, pas comme une
        // annulation propre.
        if (!startedForeground) {
            startedForeground = startForegroundCompat(buildNotification(MediaBridge.isPlaying))
        }

        // Boutons du casque / Bluetooth.
        MediaButtonReceiver.handleIntent(mediaSession, intent)

        if (intent?.action == ACTION_STOP) {
            stopEverything()
            return START_NOT_STICKY
        }

        // L'abonnement déclenche un onMediaStateChanged() synchrone, qui peut
        // conclure à l'arrêt : on ne le fait qu'une fois au premier plan.
        if (!listenerRegistered) {
            listenerRegistered = true
            MediaBridge.addListener(this)
        } else {
            pushState()
        }
        return START_STICKY
    }

    override fun onDestroy() {
        listenerRegistered = false
        MediaBridge.removeListener(this)
        releaseWakeLock()
        mediaSession.isActive = false
        mediaSession.release()
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    // ------------------------------------------------------------------

    override fun onMediaStateChanged() {
        if (!MediaBridge.isActive) {
            stopEverything()
            return
        }
        pushState()
    }

    /** Recopie l'état de [MediaBridge] dans la MediaSessionCompat + la notification. */
    private fun pushState() {
        val playing = MediaBridge.isPlaying

        mediaSession.setMetadata(
            MediaMetadataCompat.Builder()
                .putString(MediaMetadataCompat.METADATA_KEY_TITLE, MediaBridge.title)
                .putString(MediaMetadataCompat.METADATA_KEY_ARTIST, MediaBridge.artist)
                .putLong(MediaMetadataCompat.METADATA_KEY_DURATION, MediaBridge.durationMs)
                .apply {
                    MediaBridge.artwork?.let {
                        putBitmap(MediaMetadataCompat.METADATA_KEY_ALBUM_ART, it)
                    }
                }
                .build()
        )

        val actions = PlaybackStateCompat.ACTION_PLAY or
            PlaybackStateCompat.ACTION_PAUSE or
            PlaybackStateCompat.ACTION_PLAY_PAUSE or
            PlaybackStateCompat.ACTION_STOP or
            PlaybackStateCompat.ACTION_SKIP_TO_NEXT or
            PlaybackStateCompat.ACTION_SKIP_TO_PREVIOUS or
            PlaybackStateCompat.ACTION_SEEK_TO

        mediaSession.setPlaybackState(
            PlaybackStateCompat.Builder()
                .setActions(actions)
                .setState(
                    if (playing) PlaybackStateCompat.STATE_PLAYING else PlaybackStateCompat.STATE_PAUSED,
                    MediaBridge.positionMs,
                    MediaBridge.playbackRate
                )
                .build()
        )

        val notification = buildNotification(playing)

        if (!startedForeground) {
            startedForeground = startForegroundCompat(notification)
        } else {
            (getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager)
                .notify(NOTIFICATION_ID, notification)
        }

        // Le wake lock n'est tenu que pendant la lecture effective : inutile de
        // maintenir le CPU réveillé quand l'utilisateur a mis en pause.
        if (playing) acquireWakeLock() else releaseWakeLock()

        // En pause, on détache la notification du foreground pour qu'elle
        // redevienne balayable par l'utilisateur.
        if (!playing) {
            stopForeground(STOP_FOREGROUND_DETACH)
            startedForeground = false
        }
    }

    /** @return true si le service est bien passé au premier plan. */
    private fun startForegroundCompat(notification: android.app.Notification): Boolean {
        return try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                startForeground(
                    NOTIFICATION_ID,
                    notification,
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK
                )
            } else {
                startForeground(NOTIFICATION_ID, notification)
            }
            true
        } catch (e: Exception) {
            // Android 12+ : ForegroundServiceStartNotAllowedException si la
            // lecture reprend (autoplay) alors que l'app est en arrière-plan sans
            // exemption. On dégrade proprement — notification simple, pas de
            // foreground — au lieu de laisser remonter et risquer un arrêt brutal.
            Log.w(TAG, "startForeground refusé (app en arrière-plan ?)", e)
            runCatching {
                (getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager)
                    .notify(NOTIFICATION_ID, notification)
            }
            false
        }
    }

    private fun buildNotification(playing: Boolean): android.app.Notification {
        val contentIntent = PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java).apply {
                flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
            },
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )

        val builder = NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(MediaBridge.title)
            .setContentText(MediaBridge.artist)
            .setLargeIcon(MediaBridge.artwork)
            .setContentIntent(contentIntent)
            .setDeleteIntent(
                MediaButtonReceiver.buildMediaButtonPendingIntent(this, PlaybackStateCompat.ACTION_STOP)
            )
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setOnlyAlertOnce(true)
            .setShowWhen(false)
            .setOngoing(playing)
            .setPriority(NotificationCompat.PRIORITY_LOW)

        builder.addAction(
            NotificationCompat.Action(
                R.drawable.ic_skip_previous,
                getString(R.string.action_previous),
                MediaButtonReceiver.buildMediaButtonPendingIntent(
                    this, PlaybackStateCompat.ACTION_SKIP_TO_PREVIOUS
                )
            )
        )
        builder.addAction(
            NotificationCompat.Action(
                if (playing) R.drawable.ic_pause else R.drawable.ic_play,
                getString(if (playing) R.string.action_pause else R.string.action_play),
                MediaButtonReceiver.buildMediaButtonPendingIntent(
                    this, PlaybackStateCompat.ACTION_PLAY_PAUSE
                )
            )
        )
        builder.addAction(
            NotificationCompat.Action(
                R.drawable.ic_skip_next,
                getString(R.string.action_next),
                MediaButtonReceiver.buildMediaButtonPendingIntent(
                    this, PlaybackStateCompat.ACTION_SKIP_TO_NEXT
                )
            )
        )

        builder.setStyle(
            androidx.media.app.NotificationCompat.MediaStyle()
                .setMediaSession(mediaSession.sessionToken)
                .setShowActionsInCompactView(0, 1, 2)
                .setShowCancelButton(true)
                .setCancelButtonIntent(
                    MediaButtonReceiver.buildMediaButtonPendingIntent(
                        this, PlaybackStateCompat.ACTION_STOP
                    )
                )
        )

        return builder.build()
    }

    // ------------------------------------------------------------------

    private fun acquireWakeLock() {
        try {
            if (wakeLock?.isHeld != true) {
                // Pas de timeout : la lecture peut légitimement durer des heures.
                // Le lock est systématiquement relâché sur pause / arrêt / destroy.
                wakeLock?.acquire()
            }
        } catch (e: Exception) {
            Log.w(TAG, "Wake lock refusé", e)
        }
    }

    private fun releaseWakeLock() {
        try {
            if (wakeLock?.isHeld == true) wakeLock?.release()
        } catch (e: Exception) {
            Log.w(TAG, "Libération du wake lock impossible", e)
        }
    }

    private fun stopEverything() {
        releaseWakeLock()
        stopForeground(STOP_FOREGROUND_REMOVE)
        // stopForeground(REMOVE) ne suffit pas si la notification a été détachée
        // du foreground lors d'une pause (elle survit alors via notify()) : sans
        // cancel() explicite, elle resterait affichée avec des boutons pilotant
        // une MediaSession morte.
        (getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager)
            .cancel(NOTIFICATION_ID)
        startedForeground = false
        stopSelf()
    }

    private fun createChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val channel = NotificationChannel(
            CHANNEL_ID,
            getString(R.string.playback_channel_name),
            NotificationManager.IMPORTANCE_LOW
        ).apply {
            description = getString(R.string.playback_channel_desc)
            setShowBadge(false)
            lockscreenVisibility = android.app.Notification.VISIBILITY_PUBLIC
        }
        (getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager)
            .createNotificationChannel(channel)
    }

    companion object {
        private const val TAG = "TubeGuard.Playback"
        private const val CHANNEL_ID = "tubeguard_playback"
        private const val NOTIFICATION_ID = 42

        const val ACTION_START = "dev.stefan.tubeguard.START"
        const val ACTION_STOP = "dev.stefan.tubeguard.STOP"

        fun start(context: Context) {
            val intent = Intent(context, PlaybackService::class.java).setAction(ACTION_START)
            // Android 12+ interdit de démarrer un service foreground depuis
            // l'arrière-plan. Ça ne devrait pas arriver ici (la lecture est
            // toujours déclenchée par l'utilisateur au premier plan), mais une
            // ForegroundServiceStartNotAllowedException ferait planter l'app :
            // on préfère perdre la notification que le lecteur.
            runCatching { ContextCompat.startForegroundService(context, intent) }
                .onFailure { Log.w(TAG, "Démarrage du service refusé par le système", it) }
        }

        fun stop(context: Context) {
            val intent = Intent(context, PlaybackService::class.java).setAction(ACTION_STOP)
            runCatching { context.startService(intent) }
        }
    }
}
