package dev.stefan.tubeguard

import android.net.Uri

/**
 * Normalisation des liens YouTube reçus par intent, et liste des hôtes
 * considérés comme « internes » à l'app.
 */
object YouTubeLinks {

    /**
     * Hôtes qui restent dans l'app.
     *
     * Les domaines Google sont indispensables : le parcours de connexion à ton
     * compte passe par `accounts.google.com` et `consent.youtube.com`, et les
     * ressources statiques du lecteur viennent de `*.ggpht.com`, `*.gstatic.com`
     * et `*.googlevideo.com`.
     */
    private val INTERNAL_SUFFIXES = listOf(
        "youtube.com",
        "youtu.be",
        "youtube-nocookie.com",
        "ytimg.com",
        "googlevideo.com",
        "ggpht.com",
        "gstatic.com",
        "googleusercontent.com",
        "googleapis.com",
        "google.com",
        "accounts.google.com",
        "withyoutube.com",
    )

    fun isInternalHost(host: String?): Boolean {
        val h = host?.lowercase() ?: return false
        return INTERNAL_SUFFIXES.any { h == it || h.endsWith(".$it") }
    }

    /**
     * Convertit n'importe quelle forme de lien YouTube en URL chargeable par
     * l'interface mobile, ou renvoie null si ce n'est pas un lien YouTube.
     *
     *   https://youtu.be/dQw4w9WgXcQ?t=42  →  https://m.youtube.com/watch?v=dQw4w9WgXcQ&t=42
     *   https://www.youtube.com/shorts/ABC →  https://m.youtube.com/shorts/ABC
     *   vnd.youtube:dQw4w9WgXcQ            →  https://m.youtube.com/watch?v=dQw4w9WgXcQ
     */
    fun normalize(rawUrl: String): String? {
        val trimmed = rawUrl.trim()

        // Schémas propriétaires : vnd.youtube:VIDEO_ID ou vnd.youtube://VIDEO_ID
        if (trimmed.startsWith("vnd.youtube")) {
            val body = trimmed.substringAfter(':').removePrefix("//")
            val id = body.substringBefore('?').substringAfterLast('/')
            // On conserve la query (?t=42…), au même titre que la branche youtu.be.
            val query = body.substringAfter('?', "").takeIf { it.isNotBlank() }
            val extra = query?.let { "&$it" }.orEmpty()
            return if (id.isNotBlank()) "https://m.youtube.com/watch?v=$id$extra" else GeckoEngine.HOME_URL
        }

        val uri = runCatching { Uri.parse(trimmed) }.getOrNull() ?: return null
        val host = uri.host?.lowercase() ?: return null

        // Lien court youtu.be/<id>, éventuellement préfixé (youtu.be/live/<id>,
        // /shorts/<id>, /embed/<id>) : l'identifiant est le DERNIER segment, pas
        // le premier — sinon youtu.be/live/AbC deviendrait watch?v=live.
        if (host == "youtu.be" || host == "www.youtu.be") {
            val id = uri.pathSegments.lastOrNull().orEmpty()
            if (id.isBlank()) return GeckoEngine.HOME_URL
            val extra = uri.query?.takeIf { it.isNotBlank() }?.let { "&$it" }.orEmpty()
            return "https://m.youtube.com/watch?v=$id$extra"
        }

        if (!isYouTubeHost(host)) return null

        // On force le sous-domaine mobile pour garder l'UI tactile, sauf pour
        // YouTube Music qui a sa propre interface responsive.
        val mobileHost = if (host.endsWith("music.youtube.com")) "music.youtube.com" else "m.youtube.com"

        return uri.buildUpon()
            .scheme("https")
            .authority(mobileHost)
            .build()
            .toString()
    }

    private fun isYouTubeHost(host: String): Boolean =
        host == "youtube.com" ||
            host.endsWith(".youtube.com") ||
            host == "youtube-nocookie.com" ||
            host.endsWith(".youtube-nocookie.com")
}
