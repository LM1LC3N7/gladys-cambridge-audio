// -----------------------------------------------------------------------------
// The texts users read in Gladys (configuration buttons, connection status),
// in English and French.
// -----------------------------------------------------------------------------

const both = (en, fr) => ({ en, fr });
const list = (items) => items.join(', ');

export const T = {
  found: (lines) =>
    lines.length === 0
      ? both(
          'No Cambridge Audio device found. Type the IP address of each device in the configuration (the search cannot cross every network).',
          "Aucun appareil Cambridge Audio trouvé. Saisissez l'adresse IP de chaque appareil dans la configuration (la recherche ne traverse pas tous les réseaux).",
        )
      : both(
          `Found: ${list(lines)}. Create them from the Discovery tab.`,
          `Trouvés : ${list(lines)}. Créez-les depuis l'onglet Découverte.`,
        ),
  noDevice: both(
    'No device known yet: type their IP addresses in the configuration, or use "Find the devices".',
    'Aucun appareil connu : saisissez leurs adresses IP dans la configuration, ou utilisez « Chercher les appareils ».',
  ),
  check: (lines, maxVolume) => ({
    en: [...lines.map((l) => l.en), `Volume cap: ${maxVolume} %`].join(' · '),
    fr: [...lines.map((l) => l.fr), `Plafond de volume : ${maxVolume} %`].join(' · '),
  }),
  checkLine: (label, state) => {
    if (state === null || state === undefined) {
      return both(
        `${label}: not connected (eco standby, off or unreachable)`,
        `${label} : non connecté (veille éco, éteint ou injoignable)`,
      );
    }
    const power = state.zone?.power;
    const volume = state.zone?.preAmp === true && Number.isInteger(state.zone?.volume);
    const en = [power === true ? 'on' : power === false ? 'standby' : 'power unknown'];
    const fr = [power === true ? 'allumé' : power === false ? 'en veille' : 'marche inconnue'];
    if (volume) {
      en.push(`volume ${state.zone.volume}`);
      fr.push(`volume ${state.zone.volume}`);
    } else {
      en.push('volume not controlled (pre-amplifier off)');
      fr.push('volume non piloté (préampli désactivé)');
    }
    return both(`${label}: connected, ${en.join(', ')}`, `${label} : connecté, ${fr.join(', ')}`);
  },
  unreachable: (names) =>
    both(
      `Not connected (eco standby, off or unreachable), tried again at spaced intervals: ${list(names)}.`,
      `Non connectés (veille éco, éteints ou injoignables), réessayés à intervalles espacés : ${list(names)}.`,
    ),
  addressUnknown: (names) =>
    both(
      `Address unknown (another device answers at the old one): ${list(names)}. Run "Find the devices" or type the new address; a search also runs by itself every 10 minutes.`,
      `Adresse inconnue (un autre appareil répond à l'ancienne) : ${list(names)}. Lancez « Chercher les appareils » ou saisissez la nouvelle adresse ; une recherche se lance aussi d'elle-même toutes les 10 minutes.`,
    ),
  noAnswerAt: (addresses) =>
    both(
      `No StreamMagic device answers yet at: ${list(addresses)}.`,
      `Aucun appareil StreamMagic ne répond encore à : ${list(addresses)}.`,
    ),
  invalidEntries: (entries) =>
    both(
      `Ignored in the configuration (invalid): ${list(entries)}.`,
      `Ignorés dans la configuration (invalides) : ${list(entries)}.`,
    ),
  dataReset: both(
    'The saved device list was unreadable and was reset; the devices are found again from their addresses.',
    'La liste enregistrée des appareils était illisible et a été réinitialisée ; les appareils sont retrouvés par leurs adresses.',
  ),
};
