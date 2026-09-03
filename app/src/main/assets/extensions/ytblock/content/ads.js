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
  // Marqueur haute visibilité (console.error remonte dans logcat/GeckoConsole).
  try { console.error('[YTBLOCK] content script démarre sur ' + location.href); } catch (e) {}

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
    // Les deux suivants ne concernent que le document de tête : une iframe
    // (chat en direct, intégration) qui se replie ne doit pas passer « en PiP ».
    if (window.top === window) {
      // --- 1d. Contre-mesure « redimensionnement PiP » -----------------
      installPipResizeGuard(win);
      // --- 1e. Interception de pause() ---------------------------------
      installPauseInterceptor(win);
    }
  }

  /**
   * Angle « redimensionnement » pour le Picture-in-Picture.
   *
   * En PiP la fenêtre GeckoView rétrécit brutalement ; le lecteur mobile réagit
   * à ce `resize` (bascule miniplayer / détection hors-écran). Sans dépendre du
   * canal natif, on prend le rétrécissement lui-même comme signal PiP : la
   * surface du viewport tombe sous SHRINK_ENTER fois la dernière taille normale
   * connue. C'est une proportion, pas un seuil absolu — en portrait un téléphone
   * ne fait que ~400 px CSS de large, un seuil fixe se déclencherait à la
   * moindre apparition du clavier. Tant que le mode dure : on gèle les
   * dimensions rapportées (innerWidth/Height, outerWidth/Height) à la dernière
   * taille normale et on avale les `resize` avant que YouTube ne les reçoive.
   * Le mode lui-même est partagé avec le signal natif via setPipMode().
   */
  function installPipResizeGuard(win) {
    const SHRINK_ENTER = 0.3; // surface < 30 % de la référence : on est en PiP
    const SHRINK_EXIT = 0.5;  // surface ≥ 50 % de la référence : taille normale retrouvée
    const DIMENSIONS = ['innerWidth', 'innerHeight', 'outerWidth', 'outerHeight'];

    // Accesseurs natifs résolus UNE fois : nos propres getters les masquent
    // ensuite sur `win`, et la mise en page de YouTube les lit très souvent.
    const nativeGet = {};
    function realDim(name) { return nativeGet[name].call(win); }

    try {
      for (const name of DIMENSIONS) {
        nativeGet[name] = Object.getOwnPropertyDescriptor(win.Window.prototype, name).get;
      }
      viewport.refW = realDim('innerWidth');
      viewport.refH = realDim('innerHeight');
      for (const name of DIMENSIONS) {
        const native = nativeGet[name];
        const isWidth = name.endsWith('Width');
        Object.defineProperty(win, name, {
          configurable: true,
          get: exportFunction(function () {
            return keep.pip ? (isWidth ? viewport.refW : viewport.refH) : native.call(win);
          }, win),
        });
      }
    } catch (e) {
      console.warn(LOG, 'spoof dimensions impossible', e);
      return;
    }

    // Hystérésis : le seuil de sortie est plus haut que celui d'entrée, pour ne
    // pas osciller sur les resize intermédiaires de l'animation PiP.
    viewport.isShrunk = function () {
      const ref = viewport.refW * viewport.refH;
      if (ref <= 0) return false;
      const area = realDim('innerWidth') * realDim('innerHeight');
      return area < ref * (keep.pip ? SHRINK_EXIT : SHRINK_ENTER);
    };

    // Détection du (dé)rétrécissement, en phase de capture donc AVANT YouTube.
    window.addEventListener('resize', function (event) {
      const w = realDim('innerWidth');
      const h = realDim('innerHeight');
      if (viewport.refW * viewport.refH <= 0) {
        // Première taille connue (le viewport n'était pas encore établi).
        viewport.refW = w;
        viewport.refH = h;
        return;
      }
      const shrunk = viewport.isShrunk();
      if (shrunk && !keep.pip) {
        console.error('[YTBLOCK] PiP resize détecté (' + w + 'x' + h + ') -> dimensions gelées ' + viewport.refW + 'x' + viewport.refH);
        setPipMode(true, 'resize');
      } else if (!shrunk && keep.pip) {
        console.error('[YTBLOCK] sortie PiP resize (' + w + 'x' + h + ')');
        setPipMode(false, 'resize');
      }
      if (keep.pip) {
        event.stopImmediatePropagation(); // YouTube ne doit pas voir ce resize.
      } else {
        viewport.refW = w; // nouvelle taille normale de référence
        viewport.refH = h;
      }
    }, true);
  }

  /**
   * Interception de `HTMLMediaElement.prototype.pause` dans la page.
   *
   * Toutes les tentatives précédentes RÉAGISSAIENT à la pause (relance après
   * coup), ce qui donnait une saccade sans jamais tenir : le lecteur re-pausait
   * en boucle. Ici on prend le problème à la source : tant que la lecture doit
   * être maintenue (PiP, arrière-plan — voir shouldKeepPlaying), un appel à
   * pause() venant du code de la page sur la vidéo principale est simplement
   * ignoré. Une pause voulue par l'utilisateur (notification, contrôles de la
   * vignette PiP) passe par l'app, qui la signale (cmd userPause) : elle est
   * alors honorée.
   *
   * Nos propres appels (currentVideo().pause() côté content script) passent par
   * les X-rays, donc par la méthode native, jamais par le prototype de la page :
   * ils ne sont pas bloqués.
   *
   * Les premiers appels ignorés sont tracés AVEC leur pile d'appels : c'est le
   * seul moyen de savoir, sur l'appareil, quel code de YouTube met en pause.
   */
  function installPauseInterceptor(win) {
    try {
      const nativePause = HTMLMediaElement.prototype.pause; // méthode native, vue du content script
      let ignored = 0;
      win.HTMLMediaElement.prototype.pause = exportFunction(function () {
        if (shouldKeepPlaying() && isMainVideo(this)) {
          ignored++;
          if (ignored <= 3 || ignored % 50 === 0) {
            console.error('[YTBLOCK] pause() ignoré #' + ignored + ' (maintien de lecture)\n' + new Error().stack);
          }
          return undefined;
        }
        return nativePause.call(this);
      }, win);
      console.log(LOG, 'interception de pause() installée');
    } catch (e) {
      console.warn(LOG, 'interception de pause() impossible', e);
    }
  }

  function isMainVideo(el) {
    try {
      return el === currentVideo() || (el.classList && el.classList.contains('html5-main-video'));
    } catch (e) {
      return false;
    }
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

      // ── FOCUS ──────────────────────────────────────────────────────────
      // YouTube mobile met la vidéo en pause quand la FENÊTRE perd le focus
      // (passage en PiP / arrière-plan), indépendamment de la visibilité. On
      // fait donc croire que la page a toujours le focus, et on gobe les
      // évènements 'blur' de fenêtre avant que le code de YouTube ne les reçoive.
      doc.hasFocus = exportFunction(function () { return true; }, win);
      console.error('[YTBLOCK] visibilité+focus spoofés — hidden=' + doc.hidden);
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
    // 'blur' / 'pagehide' de la FENÊTRE : on ne gobe QUE ceux dont la cible est
    // la fenêtre/le document (pas le blur d'un champ de saisie, sinon on
    // casserait les formulaires).
    const swallowWindowOnly = function (event) {
      if (event.target === window || event.target === document) {
        // Personne d'autre ne verra ce blur : on note l'état de lecture ici,
        // avant de le gober (un écouteur posé plus tard ne tournerait jamais).
        if (event.type === 'blur') noteFocusLoss();
        event.stopImmediatePropagation();
      }
    };
    for (const type of ['blur', 'pagehide']) {
      window.addEventListener(type, swallowWindowOnly, true);
    }
  }

  // =========================================================================
  // 1f. Maintien de lecture : état partagé
  // =========================================================================
  //
  // « La lecture doit-elle continuer malgré ce que YouTube veut faire ? »
  // Plusieurs sources indépendantes répondent oui — aucune n'est fiable seule :
  //   - keep.native : l'app Android l'a demandé par le canal natif (écran
  //     éteint → cmd keepPlaying). Le canal est fragile à établir ;
  //   - keep.pip    : mode Picture-in-Picture, posé par le canal natif (cmd pip)
  //     OU déduit du rétrécissement de la fenêtre (installPipResizeGuard) ;
  //   - focus perdu alors que la vidéo jouait : mécanisme autonome, sans aucun
  //     message. document.hasFocus() n'est PAS spoofé côté content script (les
  //     X-rays ignorent la propriété posée sur le document de la page), il
  //     reflète la réalité : premier plan → true ; PiP, écran éteint, autre app
  //     → false.
  // Et une source dit non : keep.userPaused, pause explicite de l'utilisateur
  // (notification, casque, contrôles de la vignette PiP), signalée par l'app.
  const keep = {
    native: false,
    pip: false,
    userPaused: false,
    wasPlayingWhenUnfocused: false,
  };

  /** Géométrie du viewport, renseignée par installPipResizeGuard. */
  const viewport = { refW: 0, refH: 0, isShrunk: null };

  function shouldKeepPlaying() {
    if (keep.userPaused) return false;
    if (keep.native || keep.pip) return true;
    return keep.wasPlayingWhenUnfocused && !document.hasFocus();
  }

  /** Mémorise l'état de lecture au moment où la fenêtre perd le focus. */
  function noteFocusLoss() {
    const v = currentVideo();
    keep.wasPlayingWhenUnfocused = !!(v && !v.paused && !v.ended);
  }

  /**
   * Mode PiP (vignette) : maintien de lecture + promotion CSS du lecteur sur
   * tout le viewport, pour que la vignette Android — qui recopie la fenêtre de
   * l'Activity — ne montre que la vidéo. La classe est retirée par TOUTES les
   * voies de sortie (resize, canal natif, tick de sécurité, boot) : une classe
   * restée collée donnait autrefois un écran noir au retour.
   */
  function setPipMode(on, source) {
    if (keep.pip === on) return;
    keep.pip = on;
    document.documentElement.classList.toggle('tubeguard-pip', on);
    reportGuard('pip-' + (on ? 'on' : 'off') + ':' + source, null);
    if (on) resumeIfNeeded('pip:' + source);
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

  /** Relance `v` si elle est en pause (hors fin de vidéo) ; l'échec est ignoré. */
  function playIfPaused(v) {
    if (v && v.paused && !v.ended) v.play().catch(function () { /* réessai plus tard */ });
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
  // 3bis. Maintien de lecture : relance (filet de sécurité)
  // =========================================================================
  //
  // L'interception de pause() (section 1e) bloque les pauses venant du code de
  // la page. Restent celles que Gecko déclenche lui-même (perte de focus audio,
  // élément retiré du DOM…) : elles émettent un évènement `pause` sans passer
  // par le prototype. Pour celles-là, on relance — avec un léger délai pour
  // laisser passer une pause transitoire (changement de source).
  function resumeIfNeeded(reason) {
    if (!shouldKeepPlaying()) return;
    const v = currentVideo();
    if (!v || !v.paused || v.ended) return;
    reportGuard('resume:' + reason, true);
    v.play().then(
      function () { reportGuard('resume-ok', false); },
      function () { reportGuard('resume-FAILED', true); }
    );
  }

  /** Pause voulue par l'utilisateur (notification, casque, vignette PiP). */
  function pauseForUser() {
    keep.userPaused = true;
    const v = currentVideo();
    if (v && !v.paused) v.pause(); // X-ray → méthode native, jamais interceptée
    reportGuard('user-pause', true);
  }

  function playForUser() {
    keep.userPaused = false;
    playIfPaused(currentVideo());
    reportGuard('user-play', false);
  }

  function startPlaybackKeeper() {
    // Réaction à toute pause « native » (voir ci-dessus).
    document.addEventListener('pause', function (e) {
      if (e && e.target && e.target.tagName === 'VIDEO') {
        setTimeout(function () { resumeIfNeeded('pause-event'); }, 60);
      }
    }, true);
    // Une lecture qui (re)démarre, d'où qu'elle vienne, annule la pause
    // utilisateur : même sans canal natif, un « play » depuis la notification
    // remet le maintien en service.
    document.addEventListener('play', function (e) {
      if (e && e.target && e.target.tagName === 'VIDEO') keep.userPaused = false;
    }, true);
    // Filet de sécurité : YouTube peut re-pauser à retardement ; et si la
    // fenêtre a retrouvé sa taille sans que le resize de sortie nous soit
    // parvenu, on quitte le mode PiP ici.
    setInterval(function () {
      if (keep.pip && viewport.isShrunk && !viewport.isShrunk()) setPipMode(false, 'tick');
      resumeIfNeeded('tick');
    }, 1000);
  }

  // =========================================================================
  // 4. Canal natif : commandes venues de l'app Android
  // =========================================================================

  let appPort = null;

  function reportGuard(state, paused) {
    try {
      if (appPort) appPort.postMessage({ event: 'guard', state: state, paused: !!paused });
    } catch (e) { /* ignoré */ }
  }

  // Le canal natif est FRAGILE à établir : selon que la page se charge avant ou
  // après l'enregistrement du délégué côté Kotlin, le premier connectNative peut
  // n'être jamais délivré (onConnect manqué). Et comme m.youtube.com est une SPA,
  // le content script n'est pas réinjecté d'une vidéo à l'autre. On rend donc la
  // connexion résiliente : on (re)tente jusqu'à obtenir un port vivant, et on
  // réessaie à chaque navigation.
  let connectAttempts = 0;

  function connectToApp() {
    // Uniquement depuis le document de tête : sinon chaque iframe (chat en
    // direct, intégrations…) ouvrirait un port concurrent et volerait le canal.
    if (window.top !== window) return;
    if (appPort) return; // déjà connecté

    let port;
    try {
      port = browser.runtime.connectNative('browser');
    } catch (e) {
      // connectNative indisponible : on retente un peu plus tard.
      scheduleReconnect();
      return;
    }

    let acked = false;

    port.onMessage.addListener((msg) => {
      acked = true; // on a reçu quelque chose : le port est bien vivant
      if (!msg) return;
      if (msg.cmd === 'pip') setPipMode(!!msg.on, 'native');
      if (msg.cmd === 'keepPlaying') { keep.native = true; resumeIfNeeded('native-keep'); }
      if (msg.cmd === 'releasePlaying') keep.native = false;
      if (msg.cmd === 'userPause') pauseForUser();
      if (msg.cmd === 'userPlay') playForUser();
    });

    port.onDisconnect.addListener(() => {
      if (appPort === port) appPort = null;
      scheduleReconnect();
    });

    appPort = port;

    try {
      port.postMessage({ event: 'ready', url: location.href });
    } catch (e) {
      appPort = null;
      scheduleReconnect();
      return;
    }

    // Si dans 2 s on n'a rien reçu en retour, c'est probablement un onConnect
    // manqué côté Kotlin (course au démarrage) : on jette ce port et on relance,
    // ce qui redéclenche onConnect maintenant que le délégué est en place.
    connectAttempts++;
    if (connectAttempts <= 6) {
      setTimeout(() => {
        if (!acked) {
          try { port.disconnect(); } catch (e) { /* ignoré */ }
          appPort = null;
          connectToApp();
        }
      }, 2000);
    }
  }

  let reconnectTimer = null;
  function scheduleReconnect() {
    if (reconnectTimer || appPort) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connectToApp();
    }, 1500);
  }

  // =========================================================================
  // Démarrage
  // =========================================================================

  function boot() {
    if (!keep.pip) document.documentElement.classList.remove('tubeguard-pip');
    startAdWatcher();
    applyCosmeticFilters();
    startPlaybackKeeper();
    connectToApp();

    // m.youtube.com est une SPA : elle navigue sans recharger la page, donc le
    // content script n'est PAS réinjecté d'une vidéo à l'autre. La feuille
    // cosmétique par domaine (ytblock-cosmetic) reste valable telle quelle, mais
    // on force un skipAdIfPresent() immédiat à chaque navigation pour attraper
    // une éventuelle pré-roll sans attendre le prochain tick de 400 ms.
    const onNavigate = function () {
      skipAdIfPresent();
      connectToApp(); // reconnecte le canal natif si besoin (SPA)
    };
    window.addEventListener('yt-navigate-finish', onNavigate, true);
    document.addEventListener('yt-navigate-finish', onNavigate, true);

    console.log(LOG, 'content script actif sur', location.href);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();
