/*
 * filters.js — moteur de filtres au format Adblock Plus / uBlock Origin.
 *
 * C'est une réimplémentation volontairement compacte d'un SOUS-ENSEMBLE du
 * format. Elle couvre ce dont on a besoin pour YouTube et pour EasyList :
 *
 *   ||domaine.tld^                règle ancrée au domaine (le cas majoritaire)
 *   ||domaine.tld^$script,third-party      avec options de type / de partie
 *   |http://debut                 ancrage en début d'URL
 *   /motif/quelconque             sous-chaîne libre, avec jokers *
 *   @@||domaine.tld^              exception (whitelist)
 *   ##selecteur                   filtre cosmétique générique
 *   domaine.tld##selecteur        filtre cosmétique spécifique à un domaine
 *   domaine.tld#@#selecteur       exception cosmétique
 *   ! commentaire                 ignoré
 *
 * NON supporté (les règles concernées sont ignorées, pas mal interprétées) :
 *   - filtres procéduraux d'uBO (#?#, :has-text, :xpath, :matches-css…)
 *   - scriptlets (##+js(...)), redirections ($redirect=), $csp=, $removeparam=
 *   - expressions régulières natives (/regexp/)
 *   - $popup, $document, $genericblock, $generichide
 *
 * Conséquence à connaître : le taux de blocage est inférieur à celui d'uBlock
 * Origin. Sur YouTube ce n'est pas gênant, parce que l'essentiel du travail est
 * fait par le content script (voir content/ads.js) et non par le réseau.
 */

'use strict';

const FilterEngine = (() => {

  /** Types de ressources reconnus dans les options `$...`. */
  const KNOWN_TYPES = new Set([
    'script', 'image', 'stylesheet', 'object', 'xmlhttprequest', 'subdocument',
    'media', 'font', 'websocket', 'ping', 'other', 'document', 'beacon',
    'object-subrequest', 'xhr', 'css', 'frame',
  ]);

  /** Alias d'options vers les types webRequest de Firefox. */
  const TYPE_ALIASES = {
    xhr: 'xmlhttprequest',
    css: 'stylesheet',
    frame: 'subdocument',
    beacon: 'ping',
    'object-subrequest': 'object',
  };

  /** Options acceptées mais sans effet sur la décision de blocage. */
  const IGNORED_OPTIONS = new Set(['important', 'match-case', 'first-party', '~third-party', 'all']);

  /** Options dont la présence rend la règle inexploitable ici : on la jette. */
  const REJECT_OPTIONS = ['redirect', 'redirect-rule', 'csp', 'removeparam', 'replace',
    'popup', 'popunder', 'genericblock', 'generichide', 'elemhide', 'inline-script',
    'inline-font', 'empty', 'mp4', 'method', 'to', 'from', 'header', 'permissions'];

  // ------------------------------------------------------------------
  // Compilation d'un motif en expression régulière
  // ------------------------------------------------------------------

  const RE_SPECIAL = /[.*+?^${}()|[\]\\]/g;

  function escapeChar(ch) {
    return ch.replace(RE_SPECIAL, '\\$&');
  }

  function compilePattern(pattern) {
    let anchorDomain = false;
    let anchorStart = false;
    let anchorEnd = false;

    if (pattern.startsWith('||')) {
      anchorDomain = true;
      pattern = pattern.slice(2);
    } else if (pattern.startsWith('|')) {
      anchorStart = true;
      pattern = pattern.slice(1);
    }
    if (pattern.endsWith('|')) {
      anchorEnd = true;
      pattern = pattern.slice(0, -1);
    }

    let source = '';
    for (const ch of pattern) {
      if (ch === '*') {
        source += '.*';
      } else if (ch === '^') {
        // Le "séparateur" ABP : tout sauf [a-zA-Z0-9_%.-], ou la fin de l'URL.
        source += '(?:[^A-Za-z0-9_%.-]|$)';
      } else {
        source += escapeChar(ch);
      }
    }

    if (anchorDomain) {
      // ||exemple.com  ==>  début d'URL, n'importe quel sous-domaine
      source = '^[a-z-]+://(?:[^/?#]*\\.)?' + source;
    } else if (anchorStart) {
      source = '^' + source;
    }
    if (anchorEnd) source += '$';

    try {
      return new RegExp(source, 'i');
    } catch (e) {
      return null;
    }
  }

  /**
   * Cas ultra-fréquent : `||exemple.com^` sans joker et sans option de type.
   * On l'indexe dans une Map par nom d'hôte : la recherche devient O(1) au lieu
   * d'un parcours linéaire de dizaines de milliers de regex.
   */
  const RE_PLAIN_DOMAIN = /^\|\|([a-z0-9.-]+)\^?$/i;

  // ------------------------------------------------------------------
  // Parsing des options
  // ------------------------------------------------------------------

  function parseOptions(optionText) {
    const opts = {
      types: null,          // Set de types autorisés, ou null = tous
      excludedTypes: null,  // Set de types exclus (~script)
      thirdParty: null,     // true / false / null
      includeDomains: null, // Set
      excludeDomains: null, // Set
    };

    for (let raw of optionText.split(',')) {
      raw = raw.trim();
      if (!raw) continue;

      const negated = raw.startsWith('~');
      const name = negated ? raw.slice(1) : raw;

      if (name === 'third-party' || name === '3p') {
        opts.thirdParty = !negated;
        continue;
      }
      if (name === 'first-party' || name === '1p') {
        opts.thirdParty = negated;
        continue;
      }
      if (name.startsWith('domain=')) {
        for (const d of name.slice(7).split('|')) {
          if (!d) continue;
          if (d.startsWith('~')) {
            (opts.excludeDomains ||= new Set()).add(d.slice(1).toLowerCase());
          } else {
            (opts.includeDomains ||= new Set()).add(d.toLowerCase());
          }
        }
        continue;
      }
      if (KNOWN_TYPES.has(name)) {
        const type = TYPE_ALIASES[name] || name;
        if (negated) {
          (opts.excludedTypes ||= new Set()).add(type);
        } else {
          (opts.types ||= new Set()).add(type);
        }
        continue;
      }
      if (IGNORED_OPTIONS.has(name)) continue;
      if (REJECT_OPTIONS.some((o) => name === o || name.startsWith(o + '='))) {
        return null; // règle non supportée : on la jette
      }
      // Option inconnue : par prudence on jette la règle plutôt que de bloquer
      // plus large que prévu.
      return null;
    }
    return opts;
  }

  // ------------------------------------------------------------------
  // Moteur
  // ------------------------------------------------------------------

  class Engine {
    constructor() {
      /** Blocage : `||host^` simples, indexés par hôte. */
      this.blockHosts = new Set();
      /** Exceptions : `@@||host^` simples. */
      this.allowHosts = new Set();
      /** Règles de blocage complexes. */
      this.blockRules = [];
      /** Exceptions complexes. */
      this.allowRules = [];
      /** Sélecteurs cosmétiques génériques. */
      this.genericCosmetic = new Set();
      /** Map<domaine, Set<sélecteur>>. */
      this.domainCosmetic = new Map();
      /** Map<domaine, Set<sélecteur>> — exceptions cosmétiques (#@#). */
      this.cosmeticExceptions = new Map();

      this.stats = { parsed: 0, skipped: 0, cosmetic: 0 };
    }

    /** Repart d'un moteur vide (avant de recharger toutes les listes). */
    reset() {
      this.blockHosts.clear();
      this.allowHosts.clear();
      this.blockRules.length = 0;
      this.allowRules.length = 0;
      this.genericCosmetic.clear();
      this.domainCosmetic.clear();
      this.cosmeticExceptions.clear();
      this.stats = { parsed: 0, skipped: 0, cosmetic: 0 };
    }

    /** Ajoute toutes les règles d'un fichier de filtres. */
    parseList(text) {
      for (const line of text.split('\n')) {
        this.parseLine(line.trim());
      }
      return this.stats;
    }

    parseLine(line) {
      if (!line) return;
      // Commentaires et en-têtes de liste.
      if (line.startsWith('!') || line.startsWith('[Adblock')) return;
      // Règle cosmétique ?
      if (line.includes('##') || line.includes('#@#')) {
        return this.parseCosmetic(line);
      }
      // Filtres procéduraux / scriptlets d'uBO : non supportés.
      if (line.includes('#?#') || line.includes('#$#') || line.includes('#%#')) {
        this.stats.skipped++;
        return;
      }
      return this.parseNetwork(line);
    }

    parseCosmetic(line) {
      const isException = line.includes('#@#');
      const sep = isException ? '#@#' : '##';
      const idx = line.indexOf(sep);
      const domainPart = line.slice(0, idx).trim();
      const selector = line.slice(idx + sep.length).trim();

      if (!selector || selector.startsWith('+js(')) {
        this.stats.skipped++;
        return;
      }
      // Les pseudo-classes procédurales d'uBO ne sont pas du CSS valide.
      if (/:(has-text|matches-css|xpath|watch-attr|min-text-length|upward|remove)\(/.test(selector)) {
        this.stats.skipped++;
        return;
      }

      this.stats.cosmetic++;

      if (!domainPart) {
        if (!isException) this.genericCosmetic.add(selector);
        return;
      }

      for (const raw of domainPart.split(',')) {
        const entry = raw.trim();
        if (!entry) continue;

        // `~domain##sel` = masquer PARTOUT SAUF sur `domain`. C'est donc une
        // exception, pas un ciblage de `domain`. Confondre les deux (ce que
        // fait un simple `replace(/^~/, '')`) applique le sélecteur exactement
        // sur le site que l'auteur de la liste voulait épargner — l'inverse du
        // comportement attendu, très visible avec l'EasyList complète.
        const negated = entry.startsWith('~');
        const d = (negated ? entry.slice(1) : entry).toLowerCase();
        if (!d) continue;

        const exception = isException || negated;
        const target = exception ? this.cosmeticExceptions : this.domainCosmetic;
        if (!target.has(d)) target.set(d, new Set());
        target.get(d).add(selector);

        // Un `~domain##sel` doit aussi masquer sur tous les AUTRES domaines :
        // le sélecteur devient générique, l'exception le retire sur `domain`.
        if (negated && !isException) this.genericCosmetic.add(selector);
      }
    }

    parseNetwork(line) {
      const isException = line.startsWith('@@');
      let body = isException ? line.slice(2) : line;

      // Séparation motif / options. Attention : un `$` peut légitimement
      // figurer dans une URL, on ne coupe qu'au dernier `$` suivi d'options.
      let options = null;
      const dollar = body.lastIndexOf('$');
      if (dollar > 0) {
        const candidate = body.slice(dollar + 1);
        // '*' inclus : les listes récentes utilisent des options à TLD joker
        // ($domain=example.*). Sans lui, la partie options était recompilée
        // comme motif d'URL littéral et la règle ne matchait plus jamais.
        if (/^[a-z0-9~,=|.*_-]+$/i.test(candidate)) {
          options = parseOptions(candidate);
          if (options === null) {
            this.stats.skipped++;
            return;
          }
          body = body.slice(0, dollar);
        }
      }

      // Expressions régulières natives : non supportées.
      if (body.startsWith('/') && body.endsWith('/')) {
        this.stats.skipped++;
        return;
      }
      if (!body) {
        this.stats.skipped++;
        return;
      }

      // Chemin rapide : `||host^` sans option.
      const plain = options === null ? RE_PLAIN_DOMAIN.exec(body) : null;
      if (plain) {
        (isException ? this.allowHosts : this.blockHosts).add(plain[1].toLowerCase());
        this.stats.parsed++;
        return;
      }

      const re = compilePattern(body);
      if (!re) {
        this.stats.skipped++;
        return;
      }

      const rule = { re, opts: options };
      (isException ? this.allowRules : this.blockRules).push(rule);
      this.stats.parsed++;
    }

    // ----------------------------------------------------------------

    /**
     * @param {string} url        URL de la requête
     * @param {string} type       type webRequest (script, image, xmlhttprequest…)
     * @param {string} docHost    hôte du document parent (pour third-party / domain=)
     * @returns {boolean} true si la requête doit être bloquée
     */
    shouldBlock(url, type, docHost) {
      const host = hostOf(url);
      if (!host) return false;

      // On teste d'abord le blocage : la grande majorité des requêtes ne
      // matchent aucune règle et sortent ici sans jamais payer le balayage des
      // exceptions (qui calcule third-party + regex). L'ordre ABP « exception
      // gagnante » est préservé : les exceptions ne sont consultées QUE si un
      // blocage a matché.
      const blocked =
        matchHostSet(this.blockHosts, host) ||
        this.matchRules(this.blockRules, url, type, host, docHost);
      if (!blocked) return false;

      if (matchHostSet(this.allowHosts, host)) return false;
      if (this.matchRules(this.allowRules, url, type, host, docHost)) return false;
      return true;
    }

    matchRules(rules, url, type, host, docHost) {
      const thirdParty = isThirdParty(host, docHost);
      for (const rule of rules) {
        const o = rule.opts;
        if (o) {
          if (o.types && !o.types.has(type)) continue;
          if (o.excludedTypes && o.excludedTypes.has(type)) continue;
          if (o.thirdParty !== null && o.thirdParty !== thirdParty) continue;
          if (o.includeDomains && !matchDomainOption(o.includeDomains, docHost)) continue;
          if (o.excludeDomains && matchDomainOption(o.excludeDomains, docHost)) continue;
        }
        if (rule.re.test(url)) return true;
      }
      return false;
    }

    /** Sélecteurs CSS à injecter pour un hôte donné. */
    cosmeticFor(host) {
      const out = new Set(this.genericCosmetic);
      const excluded = new Set();

      for (const domain of domainChain(host)) {
        const rules = this.domainCosmetic.get(domain);
        if (rules) for (const s of rules) out.add(s);
        const exc = this.cosmeticExceptions.get(domain);
        if (exc) for (const s of exc) excluded.add(s);
      }
      for (const s of excluded) out.delete(s);
      return [...out];
    }
  }

  // ------------------------------------------------------------------
  // Utilitaires
  // ------------------------------------------------------------------

  function hostOf(url) {
    try {
      return new URL(url).hostname.toLowerCase();
    } catch (e) {
      return null;
    }
  }

  /** exemple : a.b.exemple.com → ["a.b.exemple.com", "b.exemple.com", "exemple.com", "com"] */
  function domainChain(host) {
    if (!host) return [];
    const parts = host.split('.');
    const out = [];
    for (let i = 0; i < parts.length - 1; i++) {
      out.push(parts.slice(i).join('.'));
    }
    return out;
  }

  /** true si l'un des domaines parents de `host` figure dans `set`. */
  function matchHostSet(set, host) {
    if (!set || set.size === 0 || !host) return false;
    for (const candidate of domainChain(host)) {
      if (set.has(candidate)) return true;
    }
    return false;
  }

  /**
   * Comme [matchHostSet], mais pour les valeurs de l'option `$domain=` : gère
   * les entrées à TLD joker `example.*` (fréquentes dans EasyList/uAssets pour
   * couvrir google.fr, google.de, google.co.uk… d'une seule règle).
   */
  function matchDomainOption(set, host) {
    if (!set || set.size === 0 || !host) return false;
    const chain = domainChain(host);
    for (const entry of set) {
      if (entry.endsWith('.*')) {
        const prefix = entry.slice(0, -1); // 'google.*' -> 'google.'
        if (chain.some((c) => c.startsWith(prefix))) return true;
      } else if (chain.includes(entry)) {
        return true;
      }
    }
    return false;
  }

  /** Deux hôtes sont "same-party" s'ils partagent leur domaine enregistrable. */
  function isThirdParty(host, docHost) {
    if (!docHost) return true;
    const a = registrableDomain(host);
    const b = registrableDomain(docHost);
    return a !== b;
  }

  /**
   * Approximation du domaine enregistrable (sans Public Suffix List).
   * Gère les suffixes composés les plus courants (co.uk, com.br…).
   */
  const COMPOUND_SUFFIXES = new Set([
    'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'co.jp', 'com.br', 'com.au',
    'co.nz', 'co.za', 'com.mx', 'com.ar', 'co.in', 'com.tr',
  ]);

  function registrableDomain(host) {
    if (!host) return '';
    const parts = host.split('.');
    if (parts.length <= 2) return host;
    const lastTwo = parts.slice(-2).join('.');
    if (COMPOUND_SUFFIXES.has(lastTwo) && parts.length >= 3) {
      return parts.slice(-3).join('.');
    }
    return lastTwo;
  }

  return { Engine, hostOf, registrableDomain };
})();
