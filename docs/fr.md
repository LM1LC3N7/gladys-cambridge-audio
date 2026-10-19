# Cambridge Audio (StreamMagic) pour Gladys

Pilotez vos amplis et streamers **Cambridge Audio** équipés de **StreamMagic**
(CXN, MXN, EVO, CXA, AXN, Edge…) depuis Gladys, en local, sans aucun cloud :
allumage, veille, volume, sourdine, source, lecture, pause, suivant,
précédent et titre en cours.

> **Important.** Cette intégration n'a jamais été testée avec un vrai appareil :
> elle a été écrite d'après la bibliothèque `aiostreammagic` (celle de Home
> Assistant) et testée avec un faux appareil seulement. Vos retours sont les
> bienvenus. Intégration non officielle, sans lien avec Cambridge Audio.

## Installation

1. Donnez à chaque appareil une **adresse IP fixe** dans votre box (bail DHCP
   réservé).
2. Dans Gladys, installez l'intégration **Cambridge Audio**, puis ouvrez sa
   configuration.
3. Saisissez les adresses IP, séparées par des virgules (par exemple
   `192.168.1.40, 192.168.1.41`). Le bouton **Chercher les appareils** peut
   aussi les trouver sur le réseau (mDNS, facultatif : la recherche ne
   traverse pas tous les réseaux).
4. Choisissez le **plafond de volume** (50 % par défaut).
5. Les appareils apparaissent dans l'onglet **Découverte** : créez-les.

L'intégration garde une connexion websocket ouverte avec chaque appareil
(`ws://<ip>/smoip`, port 80) : les changements faits sur l'appareil, sa
télécommande ou l'application StreamMagic arrivent tout de suite dans Gladys.

## Ce que vous obtenez

| Fonction           | Type Gladys                    | Remarque                                                      |
| ------------------ | ------------------------------ | ------------------------------------------------------------- |
| Marche             | état binaire (lecture seule)   | 1 allumé, 0 en veille ou injoignable                          |
| Allumer            | bouton                         | sort l'appareil de la veille réseau                           |
| Veille             | bouton                         | met l'appareil en veille réseau                               |
| Volume             | musique / volume (0 à 100)     | plafonné, seulement si le préampli de l'appareil est activé   |
| Sourdine           | bouton (télévision / sourdine) | chaque appui lit l'état puis règle l'inverse                  |
| Lecture, pause     | boutons musique                | l'action explicite, ou la bascule seulement si elle est utile |
| Suivant, précédent | boutons musique                |                                                               |
| Lecture en cours   | état musique (lecture seule)   | 1 en lecture, 0 sinon                                         |
| Source             | liste                          | les sources de l'appareil ; la liste ne fait que grandir      |
| Titre              | texte (lecture seule)          | « Artiste - Titre » (ou la station) ; « — » sans lecture      |

Volontairement, aucun **interrupteur** : un « éteins tout » ou « allume
tout » d'un assistant vocal ou d'une scène ne réveille ni ne coupe votre ampli.

## Plafond de volume

Le volume demandé depuis Gladys (tableau de bord, scène, assistant vocal) ne
dépasse jamais le plafond de la configuration : un volume plus fort est ramené
au plafond. Le plafond est relu juste avant l'envoi : une nouvelle valeur
enregistrée s'applique tout de suite. Le volume réglé sur l'appareil lui-même
(bouton, télécommande, application) n'est pas modifié par l'intégration, sauf
dans deux cas où Gladys le rendrait audible :

- **Retirer la sourdine** : si le volume de l'appareil dépasse le plafond, il
  est d'abord ramené au plafond, puis la sourdine est retirée. Si le volume
  ne peut pas être lu, rien n'est envoyé.
- **Allumer** : après le réveil, le volume est relu et ramené au plafond s'il
  le dépasse. Si l'appareil met du temps à se réveiller, l'intégration
  revérifie toutes les 1,5 s pendant 15 s environ ; au-delà, le volume n'est
  pas corrigé (l'appareil reprend le volume qu'il avait avant sa veille).

Si le préampli de l'appareil est désactivé (streamer branché sur un autre
ampli), le volume n'est ni affiché ni réglable : il se règle sur l'ampli.

## Veille et reconnexion

- En **veille réseau**, l'appareil reste joignable : l'état Marche passe à 0
  et le bouton Allumer le réveille.
- En **veille éco**, l'appareil quitte le réseau : il est affiché éteint, cité
  dans le statut de l'intégration, et l'intégration réessaie de s'y connecter
  à intervalles espacés (10 s, puis le double à chaque échec, jusqu'à 5
  minutes). Le bouton Allumer ne peut rien dans ce cas.
- Si un autre appareil répond à l'adresse d'un appareil créé (adresse
  changée), son adresse est oubliée et une recherche se lance d'elle-même
  toutes les 10 minutes ; vous pouvez aussi saisir la nouvelle adresse.

## Commandes

Chaque commande reçoit une réponse en moins de 4 secondes (Gladys attend 5
secondes). Une commande partie vers l'appareil sans confirmation est signalée
« envoyée, sans confirmation » ; l'état poussé par l'appareil montre ensuite
ce qu'il a fait. Une commande qui n'a pas pu partir est signalée « rien
envoyé » : c'est le cas de toute commande, Veille comprise, vers un appareil
non connecté. Veille et sourdine passent avant les commandes en attente.

Quand la source n'offre que la bascule lecture/pause, Lecture n'agit qu'en
pause ou à l'arrêt, Pause qu'en lecture ; dans un état intermédiaire
(connexion, mise en mémoire tampon…), la commande est refusée sans rien
envoyer.

## Boutons de la configuration

- **Chercher les appareils** : recherche mDNS par Gladys, puis les adresses
  saisies.
- **Vérifier les appareils** : l'état de connexion, la marche et le volume de
  chaque appareil, et le plafond en vigueur.

## Données et confidentialité

L'intégration ne demande ni compte ni mot de passe : le websocket StreamMagic
n'en a pas. Elle garde dans `/data/cambridge-audio.json` la liste des
appareils connus (identifiant, adresse, nom, modèle, sources). Rien ne sort de
votre réseau local.

## Limites connues

- Une seule zone (`ZONE1`), comme l'application StreamMagic.
- Pas encore de préréglages (presets), de radio, d'égaliseur, de balance, de
  luminosité de l'afficheur ni de répétition / aléatoire.
- Jamais testé avec un vrai appareil : les réponses réelles peuvent différer.
