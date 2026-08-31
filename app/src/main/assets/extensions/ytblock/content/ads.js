/*
 * content/ads.js — couche « DOM » de l'extension, celle qui fait le vrai
 * travail sur YouTube.
 *
 * Le blocage réseau seul est inefficace contre YouTube : les pubs vidéo sont
 * servies par les mêmes serveurs et les mêmes endpoints que le contenu. uBlock
 * Origin s'appuie donc, pour YouTube, sur trois techniques que l'on reprend
 * ici :
 *
 *   1. NEUTRALISATION DE LA RÉPONSE DU LECTEUR
 *      YouTube décrit ses coupures pub dans le JSON `playerResponse`, sous les
 *      clés `adPlacements`, `playerAds`, `adSlots`. On intercepte ce JSON avant
 *      que le lecteur ne le lise et on supprime ces clés : le lecteur croit
 *      alors qu'il n'y a aucune coupure à jouer.
 *      → hooks sur `window.ytInitialPlayerResponse` et sur `JSON.parse`.
 *
 *   2. SAUT DES COUPURES QUI PASSENT QUAND MÊME
 *      Filet de sécurité : si une pré-roll / mid-roll démarre malgré tout, on
 *      la détecte (classe `ad-showing` sur le lecteur), on coupe le son et on
 *      envoie la tête de lecture à la fin du spot, puis on clique « Passer ».
 *
 *   3. FILTRAGE COSMÉTIQUE
 *      Bannières, encarts « Sponsorisé » dans le fil, overlays : masqués par
 *      CSS (ads.css) + par les sélecteurs venus des listes de filtres.
 *
 * ── LIMITE STRUCTURELLE À CONNAÎTRE ─────────────────────────────────────────
 * Les points 1 et 2 dépendent de la structure interne du lecteur YouTube
 * (noms de clés JSON, noms de classes CSS). YouTube les modifie régulièrement,
 * parfois spécifiquement pour casser ce type de contournement. Quand ça arrive,
 * ce fichier doit être mis à jour — exactement comme les listes d'uBO le sont.
 * ────────────────────────────────────────────────────────────────────────────
 */

'use strict';

(() => {
  const LOG = '[ytblock]';

  // Cette extension ne s'occupe que de YouTube.
  const host = location.hostname;
  const isYouTube = /(^|\.)(youtube|youtube-nocookie)\.com$/.test(host) || host === 'youtu.be';
  if (!isYouTube) return;

  // =========================================================================
  // 1. Neutralisation du playerResponse
  // =========================================================================

  /** Clés du playerResponse qui décrivent les coupures publicitaires. */
  const AD_KEYS = [
    'adPlacements',
    'playerAds',
    'adSlots',
    'adBreakHeartbeatParams',
    'adServerData',
    'adParams',
    'importantForAds',
  ];

  /** Supprime récursivement les clés publicitaires. Renvoie true si modifié. */
  function stripAds(obj, depth) {
    depth = depth || 0;
    if (!obj || typeof obj !== 'object' || depth > 10) return false;

    let changed = false;

    for (const key of AD_KEYS) {
      if (key in obj) {
        try {
          obj[key] = undefined;
          delete obj[key];
        } catch (e) { /* objet gelé : tant pis */ }
        changed = true;
      }
    }

    // On ne descend que dans les branches où YouTube place réellement des pubs,
    // pour éviter de parcourir un objet de plusieurs mégaoctets à chaque appel.
    for (const key of ['playerResponse', 'response', 'contents', 'watchNextEndScreenRenderer']) {
      if (obj[key] && typeof obj[key] === 'object') {
        if (stripAds(obj[key], depth + 1)) changed = true;
      }
    }
    return changed;
  }

  /**
   * Les hooks doivent modifier des objets qui appartiennent au « compartiment »
   * de la page, pas à celui du content script. Firefox fournit pour cela
   * `wrappedJSObject`, `exportFunction` et `cloneInto` — c'est la méthode
   * propre, et surtout la seule qui fonctionne malgré la CSP stricte de
   * YouTube (qui interdit d'injecter un <script> inline).
   */
  function installPageHooks() {
    let win;
    try {
      win = window.wrappedJSObject;
    } catch (e) {
      console.warn(LOG, 'wrappedJSObject indisponible', e);
      return;
    }
    if (!win) return;

    // --- 1a. JSON.parse -----------------------------------------------
    try {
      const originalParse = win.JSON.parse;

      exportFunction(function (text, reviver) {
        if (typeof text === 'string' && text.length > 256 &&
            (text.indexOf('adPlacements') !== -1 ||
             text.indexOf('playerAds') !== -1 ||
             text.indexOf('adSlots') !== -1)) {
          try {
            // On désérialise dans NOTRE compartiment, on nettoie, on
            // resérialise : le lecteur ne verra jamais les clés de pub.
            const parsed = JSON.parse(text);
            if (stripAds(parsed)) text = JSON.stringify(parsed);
          } catch (e) { /* JSON exotique : on laisse passer tel quel */ }
        }
        return originalParse.call(this, text, reviver);
      }, win.JSON, { defineAs: 'parse' });

      console.log(LOG, 'hook JSON.parse installé');
    } catch (e) {
      console.warn(LOG, 'hook JSON.parse impossible', e);
    }

    // --- 1b. window.ytInitialPlayerResponse ----------------------------
    // Sur la première page chargée, le playerResponse est écrit directement
    // dans une balise <script> et ne passe donc pas par JSON.parse. On piège
    // l'affectation avec un accesseur.
    try {
      let stored;

      const descriptor = cloneInto({
        configurable: true,
        enumerable: true,
        get: exportFunction(function () { return stored; }, win),
        set: exportFunction(function (value) {
          try { stripAds(value); } catch (e) { /* ignoré */ }
          stored = value;
        }, win),
      }, win, { cloneFunctions: true });

      win.Object.defineProperty(win, 'ytInitialPlayerResponse', descriptor);
      console.log(LOG, 'hook ytInitialPlayerResponse installé');
    } catch (e) {
      console.warn(LOG, 'hook ytInitialPlayerResponse impossible', e);
    }

    // --- 1c. Lecture en arrière-plan -----------------------------------
    keepPlayingInBackground(win);
  }

  /**
   * Empêche YouTube de mettre la vidéo en pause quand l'app passe en
   * arrière-plan ou en Picture-in-Picture.
   *
   * Le lecteur web s'appuie sur l'API Page Visibility : dès que
   * `document.hidden` passe à true (app masquée), il se met en pause de
   * lui-même. Le service Android garde bien le process vivant, mais ça ne sert
   * à rien si la page se coupe toute seule. On fait donc croire au lecteur que
   * l'onglet reste TOUJOURS visible :
   *   - `document.hidden` renvoie toujours false, `visibilityState` « visible » ;
   *   - les évènements `visibilitychange` sont avalés avant que le code de
   *     YouTube (enregistré plus tard) ne les reçoive.
   */
  function keepPlayingInBackground(win) {
    try {
      const doc = win.document;
      const alwaysVisible = exportFunction(function () { return 'visible'; }, win);
      const neverHidden = exportFunction(function () { return false; }, win);

      Object.defineProperty(doc, 'hidden', { configurable: true, get: neverHidden });
      Object.defineProperty(doc, 'visibilityState', { configurable: true, get: alwaysVisible });
      // Variantes préfixées, encore lues par certaines versions du lecteur.
      Object.defineProperty(doc, 'webkitHidden', { configurable: true, get: neverHidden });
      Object.defineProperty(doc, 'webkitVisibilityState', { configurable: true, get: alwaysVisible });
      console.log(LOG, 'lecture en arrière-plan : visibilité spoofée');
    } catch (e) {
      console.warn(LOG, 'spoof de visibilité impossible', e);
    }

    // On enregistre nos gobeurs à document_start, donc AVANT les écouteurs de
    // YouTube : stopImmediatePropagation empêche les leurs de se déclencher.
    const swallow = function (event) {
      event.stopImmediatePropagation();
    };
    for (const type of ['visibilitychange', 'webkitvisibilitychange']) {
      document.addEventListener(type, swallow, true);
      window.addEventListener(type, swallow, true);
    }
  }

  installPageHooks();

  // =========================================================================
  // 2. Saut des coupures publicitaires dans le lecteur
  // =========================================================================

  const PLAYER_SELECTORS = '#movie_player, .html5-video-player, ytm-app #player';

  /** Boutons « Passer l'annonce », toutes variantes desktop / mobile. */
  const SKIP_BUTTONS = [
    '.ytp-ad-skip-button',
    '.ytp-ad-skip-button-modern',
    '.ytp-skip-ad-button',
    '.ytp-ad-survey-answer-button',
    'button.ytp-ad-skip-button-modern',
    '.videoAdUiSkipButton',
  ];

  /** Croix de fermeture des overlays publicitaires. */
  const CLOSE_BUTTONS = [
    '.ytp-ad-overlay-close-button',
    '.ytp-ad-overlay-close-container',
    'ytm-companion-ad-renderer .close-button',
  ];

  /** Nœuds à retirer purement et simplement du DOM. */
  const REMOVE_SELECTORS = [
    '.ytp-ad-overlay-container',
    '.ytp-ad-message-container',
    'ytm-promoted-video-renderer',
    'ytm-companion-ad-renderer',
    'ytm-promoted-sparkles-web-renderer',
    'ytm-carousel-ad-renderer',
    'ytd-ad-slot-renderer',
    'ytd-display-ad-renderer',
    'ytd-promoted-sparkles-web-renderer',
    'ytd-in-feed-ad-layout-renderer',
    'ytd-banner-promo-renderer',
    '#masthead-ad',
  ];

  /** Mémorise l'état « muet » d'avant la coupure, pour le restaurer après. */
  let mutedByUs = false;
  let previousVolume = null;

  function currentVideo() {
    return document.querySelector('video.html5-main-video') ||
           document.querySelector('video');
  }

  /**
   * Vrai UNIQUEMENT quand le lecteur signale une coupure pub en cours, via la
   * classe `ad-showing` / `ad-interrupting` qu'il pose sur `#movie_player`.
   *
   * ⚠️ On ne se fie SURTOUT PAS à la simple présence d'un `.ytp-ad-player-overlay`
   * dans le DOM : YouTube laisse ce nœud (caché) après la fin d'une pub. S'en
   * servir comme signal ferait croire à une pub permanente et l'anti-pub
   * enverrait la VRAIE vidéo à sa fin toutes les 400 ms — chaque vidéo
   * deviendrait injouable.
   */
  function adIsPlaying(player) {
    if (!player) return false;
    return player.classList.contains('ad-showing') ||
           player.classList.contains('ad-interrupting');
  }

  function skipAdIfPresent() {
    const player = document.querySelector(PLAYER_SELECTORS);
    const video = currentVideo();

    if (adIsPlaying(player) && video) {
      // Coupe le son immédiatement : même sautée, une pub reste audible
      // quelques dixièmes de seconde.
      if (!mutedByUs && !video.muted) {
        previousVolume = video.volume;
        video.muted = true;
        mutedByUs = true;
      }

      // Envoie la tête de lecture à la fin du spot. YouTube enchaîne alors
      // sur la vidéo demandée comme si la pub avait été regardée.
      if (isFinite(video.duration) && video.duration > 0) {
        try {
          video.currentTime = video.duration;
          if (video.paused) video.play();
        } catch (e) { /* seek refusé, on retentera au tick suivant */ }
      }

      notifyAdSkipped();
    } else if (mutedByUs) {
      // Fin de la coupure : on rétablit le son.
      const v = currentVideo();
      if (v) {
        v.muted = false;
        if (previousVolume !== null) v.volume = previousVolume;
      }
      mutedByUs = false;
      previousVolume = null;
    }

    // Les boutons « Passer » restent utiles : certains formats ne sont pas
    // seekables et le clic est le seul moyen de sortir.
    clickAll(SKIP_BUTTONS);
    clickAll(CLOSE_BUTTONS);
    removeAll(REMOVE_SELECTORS);
  }

  function clickAll(selectors) {
    for (const selector of selectors) {
      const nodes = document.querySelectorAll(selector);
      for (const node of nodes) {
        if (node.offsetParent !== null || node.getClientRects().length) {
          try { node.click(); } catch (e) { /* ignoré */ }
        }
      }
    }
  }

  function removeAll(selectors) {
    for (const selector of selectors) {
      const nodes = document.querySelectorAll(selector);
      for (const node of nodes) {
        try { node.remove(); } catch (e) { /* ignoré */ }
      }
    }
  }

  let lastNotify = 0;
  function notifyAdSkipped() {
    const now = Date.now();
    if (now - lastNotify < 5000) return; // anti-spam
    lastNotify = now;
    try { browser.runtime.sendMessage({ type: 'adSkipped' }); } catch (e) { /* ignoré */ }
  }

  // Deux déclencheurs complémentaires :
  //  - l'observateur réagit instantanément à l'apparition du conteneur de pub ;
  //  - le timer rattrape les cas où YouTube modifie l'état sans toucher au DOM
  //    observé (changement de classe sur un ancêtre, lecture programmatique…).
  function startAdWatcher() {
    const observer = new MutationObserver(() => skipAdIfPresent());
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class'],
    });
    setInterval(skipAdIfPresent, 400);
    skipAdIfPresent();
  }

  // =========================================================================
  // 3. Filtrage cosmétique issu des listes de filtres
  // =========================================================================

  let cosmeticApplied = false;

  async function applyCosmeticFilters(attempt) {
    attempt = attempt || 0;
    if (cosmeticApplied) return;

    let selectors = [];
    let ready = false;
    try {
      const response = await browser.runtime.sendMessage({ type: 'cosmetic', host });
      selectors = (response && response.selectors) || [];
      ready = !!(response && response.ready);
    } catch (e) {
      // background pas encore joignable
    }

    // Au démarrage à froid, la première page se charge AVANT que le background
    // ait fini de parser ses listes (engineReady=false) : il répondrait alors
    // un jeu vide qui ne serait jamais réappliqué de toute la session. On
    // réessaie donc tant qu'il n'est pas prêt (jusqu'à ~15 s), la feuille
    // statique ads.css couvrant l'intervalle.
    if (!ready && attempt < 30) {
      setTimeout(() => applyCosmeticFilters(attempt + 1), 500);
      return;
    }
    if (!selectors.length) return;

    // On injecte par paquets : une feuille de style de 20 000 sélecteurs fait
    // ramer le moteur de style sur mobile.
    const style = document.createElement('style');
    style.id = 'ytblock-cosmetic';
    style.textContent = selectors
      .slice(0, 4000)
      .map((s) => `${s}{display:none!important}`)
      .join('\n');
    (document.head || document.documentElement).appendChild(style);
    cosmeticApplied = true;
  }

  // =========================================================================
  // 4. Canal natif : commandes venues de l'app Android
  // =========================================================================

  /**
   * Mode « PiP » : au lieu de demander le plein écran HTML (que Firefox refuse
   * sans geste utilisateur récent), on promeut le lecteur en position fixe sur
   * tout le viewport via une classe CSS. Le résultat visuel est identique du
   * point de vue de la vignette Picture-in-Picture d'Android, qui recopie la
   * fenêtre de l'Activity.
   */
  function setPipLayout(enabled) {
    document.documentElement.classList.toggle('tubeguard-pip', enabled);
  }

  function connectToApp() {
    // Uniquement depuis le document de tête : sinon chaque iframe (chat en
    // direct, intégrations…) ouvrirait un port concurrent et volerait le canal.
    if (window.top !== window) return;

    let port;
    try {
      port = browser.runtime.connectNative('browser');
    } catch (e) {
      return; // l'app n'écoute pas : sans conséquence
    }

    port.onMessage.addListener((msg) => {
      if (!msg) return;
      if (msg.cmd === 'enterVideoFullscreen') setPipLayout(true);
      if (msg.cmd === 'exitVideoFullscreen') setPipLayout(false);
    });

    try {
      port.postMessage({ event: 'ready', url: location.href });
    } catch (e) { /* ignoré */ }
  }

  // =========================================================================
  // Démarrage
  // =========================================================================

  function boot() {
    startAdWatcher();
    applyCosmeticFilters();
    connectToApp();

    // m.youtube.com est une SPA : elle navigue sans recharger la page, donc le
    // content script n'est PAS réinjecté d'une vidéo à l'autre. La feuille
    // cosmétique par domaine (ytblock-cosmetic) reste valable telle quelle, mais
    // on force un skipAdIfPresent() immédiat à chaque navigation pour attraper
    // une éventuelle pré-roll sans attendre le prochain tick de 400 ms.
    window.addEventListener('yt-navigate-finish', skipAdIfPresent, true);
    document.addEventListener('yt-navigate-finish', skipAdIfPresent, true);

    console.log(LOG, 'content script actif sur', location.href);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();
