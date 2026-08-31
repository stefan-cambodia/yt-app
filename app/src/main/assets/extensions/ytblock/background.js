/*
 * background.js — couche « blocage réseau » de l'extension.
 *
 * Équivalent (très) simplifié du moteur statique d'uBlock Origin :
 * on charge des listes de filtres au format Adblock Plus, et on refuse les
 * requêtes qui correspondent, via webRequest.onBeforeRequest en mode blocking.
 *
 * ⚠️ POINT CRITIQUE — NE JAMAIS BLOQUER LE FLUX VIDÉO
 * Sur YouTube, la publicité et la vidéo transitent par les MÊMES endpoints
 * (`/youtubei/v1/player`, `*.googlevideo.com/videoplayback`). Un blocage réseau
 * trop large ne supprime pas la pub : il casse la lecture. C'est pourquoi :
 *   - une liste d'exclusions dure (NEVER_BLOCK) est vérifiée en premier ;
 *   - le vrai travail anti-pré-roll / mid-roll est fait côté DOM par
 *     content/ads.js, pas ici.
 */

'use strict';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const CONFIG = {
  /** Listes embarquées dans l'APK (chargées à chaque démarrage). */
  bundledLists: [
    'filters/youtube.txt',
    'filters/easylist-min.txt',
  ],

  /**
   * Mise à jour des listes depuis Internet.
   *
   * Les listes embarquées sont volontairement courtes (elles vivent dans
   * l'APK). Activer cette option télécharge les vraies listes complètes et les
   * met en cache dans storage.local — c'est ce qui rapproche vraiment le
   * comportement de celui d'uBlock Origin.
   *
   * Mets `enabled: false` si tu préfères zéro requête réseau au démarrage.
   */
  remoteUpdate: {
    enabled: true,
    intervalMs: 3 * 24 * 60 * 60 * 1000, // tous les 3 jours
    urls: [
      // EasyList — la liste anti-pub de référence.
      'https://easylist.to/easylist/easylist.txt',
      // Liste cosmétique spécifique YouTube maintenue par le projet uBO.
      'https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/annoyances-others.txt',
    ],
    /** Au-delà, on ignore la liste (protection mémoire sur mobile). */
    maxBytes: 6 * 1024 * 1024,
  },
};

/**
 * Motifs qui ne doivent JAMAIS être bloqués, quelle que soit la règle qui
 * matche. C'est le garde-fou anti « j'ai cassé YouTube ».
 */
const NEVER_BLOCK = [
  /\/videoplayback/i,
  /\/youtubei\/v1\/(player|next|browse|search|guide|navigation|reel)/i,
  /googlevideo\.com/i,
  /\/generate_204/i,
  /accounts\.google\.com/i,
  /\/s\/player\//i,          // le code JS du lecteur
  /i\.ytimg\.com/i,          // miniatures
];

/**
 * Motifs YouTube spécifiquement publicitaires / télémétrie pub.
 * Ils sont sûrs à bloquer : ne pas les servir n'empêche pas la lecture.
 */
const YOUTUBE_AD_PATTERNS = [
  /^https?:\/\/[^/]*\.youtube\.com\/pagead\//i,
  /^https?:\/\/[^/]*\.youtube\.com\/ptracking/i,
  /^https?:\/\/[^/]*\.youtube\.com\/api\/stats\/ads/i,
  /^https?:\/\/[^/]*\.youtube\.com\/api\/stats\/qoe\?.*adformat/i,
  /^https?:\/\/[^/]*\.youtube\.com\/get_midroll_/i,
  /^https?:\/\/[^/]*\.youtube\.com\/youtubei\/v1\/log_event/i,
  /^https?:\/\/[^/]*\.youtube\.com\/error_204/i,
  /doubleclick\.net/i,
  /googleadservices\.com/i,
  /googlesyndication\.com/i,
  /google-analytics\.com/i,
  /googletagservices\.com/i,
  /^https?:\/\/ade?\.googlesyndication/i,
  /static\.doubleclick\.net/i,
  /^https?:\/\/[^/]*\.google\.com\/pagead\//i,
];

// ---------------------------------------------------------------------------
// État
// ---------------------------------------------------------------------------

const engine = new FilterEngine.Engine();
let blockedTotal = 0;
let engineReady = false;

// ---------------------------------------------------------------------------
// Chargement des listes
// ---------------------------------------------------------------------------

async function loadBundledLists() {
  for (const path of CONFIG.bundledLists) {
    try {
      const res = await fetch(browser.runtime.getURL(path));
      const text = await res.text();
      engine.parseList(text);
      console.log(`[ytblock] liste embarquée chargée : ${path}`);
    } catch (e) {
      console.warn(`[ytblock] impossible de charger ${path}`, e);
    }
  }
}

async function loadCachedRemoteLists() {
  try {
    const store = await browser.storage.local.get('remoteLists');
    const cached = store.remoteLists;
    if (!cached) return false;
    for (const [url, text] of Object.entries(cached.byUrl || {})) {
      engine.parseList(text);
      console.log(`[ytblock] liste distante (cache) chargée : ${url}`);
    }
    return true;
  } catch (e) {
    console.warn('[ytblock] cache des listes distantes illisible', e);
    return false;
  }
}

async function refreshRemoteListsIfNeeded() {
  if (!CONFIG.remoteUpdate.enabled) return;

  let store;
  try {
    store = (await browser.storage.local.get('remoteLists')).remoteLists;
  } catch (e) {
    store = null;
  }

  const age = store ? Date.now() - (store.fetchedAt || 0) : Infinity;
  if (age < CONFIG.remoteUpdate.intervalMs) return;

  console.log('[ytblock] mise à jour des listes de filtres…');
  const byUrl = {};
  const fresh = [];

  for (const url of CONFIG.remoteUpdate.urls) {
    try {
      const res = await fetch(url, { cache: 'no-cache' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      if (text.length > CONFIG.remoteUpdate.maxBytes) {
        console.warn(`[ytblock] ${url} ignorée (trop volumineuse : ${text.length} o)`);
        continue;
      }
      byUrl[url] = text;
      fresh.push(text);
      console.log(`[ytblock] ${url} téléchargée (${text.length} o)`);
    } catch (e) {
      console.warn(`[ytblock] échec du téléchargement de ${url}`, e);
    }
  }

  if (fresh.length) {
    // Reconstruction complète du moteur : listes embarquées PUIS listes
    // fraîches. On ne fait pas `engine.parseList` par-dessus l'existant, car
    // le cache distant a déjà été chargé au démarrage — un simple ajout
    // dupliquerait chaque règle (les règles complexes sont stockées en
    // tableaux, non dédupliqués).
    engine.reset();
    await loadBundledLists();
    for (const text of fresh) engine.parseList(text);

    try {
      await browser.storage.local.set({
        remoteLists: { fetchedAt: Date.now(), byUrl },
      });
    } catch (e) {
      console.warn('[ytblock] impossible de mettre en cache les listes', e);
    }
    console.log('[ytblock] moteur reconstruit', engine.stats);
  }
}

// ---------------------------------------------------------------------------
// Filtrage réseau
// ---------------------------------------------------------------------------

function isNeverBlocked(url) {
  return NEVER_BLOCK.some((re) => re.test(url));
}

function isYouTubeAd(url) {
  return YOUTUBE_AD_PATTERNS.some((re) => re.test(url));
}

function onBeforeRequest(details) {
  const url = details.url;

  // On ne bloque jamais la navigation principale : sinon un faux positif
  // rendrait l'app inutilisable (page blanche).
  if (details.type === 'main_frame') return {};

  if (isNeverBlocked(url)) return {};

  let block = isYouTubeAd(url);

  if (!block && engineReady) {
    const docHost = details.documentUrl ? FilterEngine.hostOf(details.documentUrl) : null;
    block = engine.shouldBlock(url, details.type, docHost);
  }

  if (block) {
    blockedTotal++;
    return { cancel: true };
  }
  return {};
}

function registerNetworkFilter() {
  try {
    browser.webRequest.onBeforeRequest.addListener(
      onBeforeRequest,
      { urls: ['<all_urls>'] },
      ['blocking']
    );
    console.log('[ytblock] filtrage réseau actif (webRequest blocking)');
    return true;
  } catch (e) {
    // Si GeckoView refuse `webRequestBlocking` pour une extension builtIn, on
    // continue quand même : le filtrage cosmétique et l'anti-pré-roll du
    // content script fonctionnent sans aucune permission réseau.
    console.error(
      '[ytblock] webRequest bloquant indisponible — mode COSMÉTIQUE SEUL. ' +
      'Les coupures pub seront quand même sautées par content/ads.js.',
      e
    );
    return false;
  }
}

// ---------------------------------------------------------------------------
// Communication avec le content script et avec l'app Android
// ---------------------------------------------------------------------------

browser.runtime.onMessage.addListener((msg, sender) => {
  if (!msg || typeof msg !== 'object') return;

  if (msg.type === 'cosmetic') {
    // Le content script demande les sélecteurs à masquer pour son hôte. On
    // renvoie `ready` : tant que le moteur n'a pas fini de parser ses listes,
    // le content script réessaiera au lieu de s'accrocher à un jeu vide.
    const host = msg.host || (sender.url ? FilterEngine.hostOf(sender.url) : null);
    return Promise.resolve({
      ready: engineReady,
      selectors: engineReady && host ? engine.cosmeticFor(host) : [],
    });
  }

  if (msg.type === 'stats') {
    return Promise.resolve({ blocked: blockedTotal, ready: engineReady });
  }
});

// NB : le background n'ouvre PAS de canal connectNative vers l'app. GeckoView ne
// délivre les ports d'un background script qu'à un délégué d'EXTENSION
// (WebExtension.setMessageDelegate), pas au délégué de SESSION utilisé par
// NativeBridge — un tel port n'aurait donc aucun destinataire. Le seul canal
// natif est celui du content script (content/ads.js), pour le Picture-in-Picture.

// ---------------------------------------------------------------------------
// Démarrage
// ---------------------------------------------------------------------------

(async function main() {
  registerNetworkFilter();

  await loadBundledLists();
  engineReady = true;               // on filtre déjà avec les listes locales
  console.log('[ytblock] moteur prêt', engine.stats);

  await loadCachedRemoteLists();
  // Volontairement non attendu : la navigation ne doit pas être retardée par
  // le téléchargement des listes complètes.
  refreshRemoteListsIfNeeded().then(() => {
    console.log('[ytblock] listes à jour', engine.stats);
  });
})();
