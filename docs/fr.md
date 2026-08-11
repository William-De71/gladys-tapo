# Intégration Tapo pour Gladys Assistant

Cette intégration ajoute vos caméras et sonnettes **TP-Link Tapo** à Gladys : l'image de la caméra sur votre tableau de bord, l'appui sur la sonnette et la détection de mouvement comme déclencheurs de scènes, et le niveau de batterie des modèles sans fil.

## Comment ça marche

Deux canaux, chacun pour ce qu'il sait faire :

- **Le cloud TP-Link** sert à retrouver la liste de vos caméras et à remonter leurs événements (sonnerie, mouvement, batterie). C'est le même compte que dans l'application Tapo. En revanche, il ne communique **pas** l'adresse locale des caméras.
- **Un scan de votre réseau** localise ensuite chaque caméra, exactement comme le fait l'application Tapo au démarrage. C'est ce qui évite d'avoir à saisir la moindre adresse IP.
- **Votre réseau local** fournit les images. Elles ne transitent jamais par le cloud : Gladys interroge directement la caméra chez vous.

Pour capturer une image, l'intégration choisit automatiquement l'un des deux modes selon ce que la caméra accepte :

| Mode             | Quand il est utilisé                       | Ce qu'il demande                              |
| ---------------- | ------------------------------------------ | --------------------------------------------- |
| **RTSP**         | La caméra expose un flux RTSP (port 554)   | Un compte caméra créé dans l'application Tapo |
| **Propriétaire** | La caméra n'expose pas de RTSP (port 8800) | Rien de plus que votre compte Tapo            |

Le second mode est le protocole interne de TP-Link, celui qu'utilise l'application mobile. Il permet de récupérer une image des modèles — souvent sur batterie — qui ne proposent aucun flux standard.

## Installation

### 1. Renseignez votre compte Tapo

Dans l'écran **Configuration** de l'intégration, saisissez l'e-mail et le mot de passe de votre compte TP-Link / Tapo, puis choisissez la région du cloud la plus proche (Europe par défaut).

### 2. Créez un compte caméra (recommandé)

Si vos caméras sont filaires (C100, C200, C210, C500…), le mode RTSP est préférable : plus léger et plus robuste. Il faut pour cela créer un compte caméra dans l'application Tapo :

1. Ouvrez l'application Tapo et sélectionnez votre caméra.
2. Allez dans **Paramètres de la caméra** → **Paramètres avancés** → **Compte de la caméra**.
3. Définissez un identifiant et un mot de passe.
4. Reportez-les dans la section **Compte caméra (RTSP)** de la configuration Gladys.

Attention : ce compte caméra est **différent** de votre compte Tapo, et il se crée **par caméra**. Deux façons de le renseigner :

- si vous avez utilisé les **mêmes identifiants** sur toutes vos caméras, remplissez simplement les champs **Identifiant / Mot de passe du compte par défaut** ;
- sinon, remplissez **Comptes par caméra**, en séparant les caméras par une **virgule**, chacune sous la forme `nom|identifiant|motdepasse` :

```
Camera_jardin|gladys|MonMotDePasse, Camera_salon|gladys|AutreMotDePasse
```

Le champ de saisie tient sur une seule ligne : c'est la virgule qui sépare les caméras. Un mot de passe contenant une virgule doit donc être placé dans les champs par défaut. Reprenez le nom de la caméra tel qu'il apparaît dans l'application Tapo. Ces comptes sont prioritaires sur le compte par défaut. Si vous laissez tout vide, l'intégration utilisera le mode propriétaire pour toutes vos caméras.

Sur certains modèles, il faut également activer **Compatibilité tierce** (dans l'application Tapo, rubrique _Moi_ → _Tapo Lab_) pour que le flux RTSP soit accessible.

### 3. Lancez un scan

Cliquez sur **Tester la connexion** pour vérifier que vos identifiants sont acceptés : Gladys vous indique combien de caméras ont été trouvées et combien répondent sur votre réseau.

Rendez-vous ensuite dans l'écran **Découverte** et lancez un scan. Vos caméras y apparaissent, prêtes à être ajoutées. Une fois créées, ajoutez le widget **Caméra** à votre tableau de bord.

## Ce que les caméras sur batterie font — et ne font pas

Les modèles sur batterie ou solaires (C610, C425, D230…) n'exposent ni RTSP ni ONVIF : ils ne parlent que le protocole propriétaire de TP-Link. Cela a deux conséquences concrètes.

### Pas de flux vidéo en direct

Ces caméras affichent des **images rafraîchies régulièrement**, pas un flux continu. La vue live de Gladys s'appuie sur une URL confiée à ffmpeg, or une session propriétaire est chiffrée et pilotée par l'intégration elle-même : elle ne peut pas s'écrire sous forme d'URL. Les caméras filaires en RTSP, elles, ont bien le direct.

Ce n'est pas une limite de l'intégration mais du protocole : aucun outil ne fait autrement sur ces modèles, sauf à passer par un relais externe comme go2rtc.

### La batterie est ménagée automatiquement

Capturer une image est de loin ce qui sollicite le plus une caméra. Sur un modèle solaire, une capture trop fréquente vide la batterie plus vite que le panneau ne la remplit — et une batterie lithium descendue trop bas peut cesser d'accepter la charge, ce qui ne se rattrape pas à distance.

L'intégration lève donc le pied d'elle-même :

| Batterie           | Rafraîchissement automatique | Widget, scène, sonnette |
| ------------------ | ---------------------------- | ----------------------- |
| au-dessus de 60 %  | oui                          | oui                     |
| entre 40 % et 60 % | suspendu                     | oui                     |
| sous 40 %          | suspendu                     | non                     |

Une caméra passée sous le premier seuil ne reprend qu'à **80 %**, volontairement bien au-dessus du seuil de pause : une reprise juste au-dessus relancerait la décharge aussitôt, et les cycles courts répétés usent la batterie plus vite qu'un cycle complet. Évitez de régler ce niveau à 100 % : une caméra solaire se recharge par à-coups et atteint rarement le plein exact, ce qui la laisserait en pause indéfiniment.

Le niveau de batterie et les événements continuent d'être lus dans tous les cas : cela ne coûte presque rien, et c'est ce qui permet de savoir quand la caméra est rechargée.

Une caméra sur batterie qui **cesse de répondre** — veille profonde, session refusée, réseau coupé — est également ramenée au mode « à la demande » : son dernier niveau connu n'est plus fiable, et une caméra muette a plus de chances d'être vide que pleine.

### Un intervalle de capture propre aux caméras sur batterie

Les caméras sur batterie ont leur **propre intervalle de rafraîchissement**, indépendant de celui des caméras filaires. Espacer les captures d'un modèle solaire ne dégrade donc pas la fraîcheur des images de vos caméras sur secteur.

| Réglage                                                 | Par défaut     | Concerne                       |
| ------------------------------------------------------- | -------------- | ------------------------------ |
| Intervalle de rafraîchissement des images               | 60 s           | caméras sur secteur uniquement |
| Intervalle de rafraîchissement des caméras sur batterie | 900 s (15 min) | caméras sur batterie/solaires  |

C'est le réglage le plus efficace de tous : c'est le **réveil** de la caméra qui coûte de la batterie, bien plus que l'image elle-même. En hiver, ou si votre panneau est peu exposé, allongez cet intervalle et montez le seuil de pause.

## Fonctionnalités créées

Chaque caméra devient un appareil dans Gladys :

- **Image** — la photo affichée par le widget caméra, rafraîchie à la demande.
- **Sonnette** — un appui sur le bouton, utilisable comme déclencheur de scène.
- **Mouvement** — la détection de mouvement, également utilisable comme déclencheur.
- **Batterie** — le niveau restant, en pourcentage (modèles sur batterie).

Lorsque quelqu'un sonne, l'intégration capture immédiatement une image et l'envoie à Gladys : le widget affiche déjà le visiteur au moment où vous consultez la notification.

### Comment les événements remontent

Deux chemins possibles, choisis automatiquement pour chaque caméra :

| Chemin            | Comment ça marche                                                 | Délai                 |
| ----------------- | ----------------------------------------------------------------- | --------------------- |
| **ONVIF**         | La caméra prévient Gladys au moment où elle détecte quelque chose | quasi immédiat        |
| **Interrogation** | Gladys demande régulièrement à la caméra ce qu'elle a détecté     | jusqu'à un intervalle |

ONVIF est nettement préférable pour déclencher une scène : un mouvement remonte en une seconde au lieu d'attendre la prochaine vérification. Il demande simplement que le **compte caméra** soit renseigné — ce sont ces identifiants-là qu'ONVIF utilise, pas votre compte Tapo.

C'est aussi le seul chemin qui signale la **fin** d'un mouvement : le capteur retombe quand la caméra le dit, et non au bout d'un délai fixe.

Les caméras filaires (C210, C200, C500…) proposent généralement ONVIF, ce qui leur donne un capteur de mouvement qu'elles n'avaient pas auparavant. Les modèles sur batterie ne le proposent pas et restent sur l'interrogation : ce n'est pas gênant, leurs détections remontent quand même, simplement avec un léger décalage.

Vous n'avez rien à configurer : si le compte caméra est renseigné et que la caméra accepte ONVIF, l'intégration l'utilise ; sinon elle interroge la caméra comme avant.

## Mode privé

Les caméras Tapo disposent d'un mode privé qui masque physiquement l'objectif. Il apparaît dans Gladys comme un interrupteur, utilisable dans une scène — « quand j'arrive, coupe la caméra du salon ».

Il ne passe pas par ONVIF (c'est une fonction propre à TP-Link) mais par le même canal local que le niveau de batterie. Aucun compte caméra n'est donc nécessaire : le mot de passe de votre compte Tapo suffit, et les modèles sur batterie en bénéficient aussi.

L'interrupteur fonctionne **dans les deux sens**. Une bascule faite depuis l'application Tapo remonte dans Gladys à la vérification suivante, dans la minute.

Pendant que le mode privé est actif, la caméra continue de diffuser mais ne montre plus qu'une image noire portant « Privacy Mode is on ». L'intégration ne la capture donc pas : le widget conserve sa dernière image utile au lieu de virer au noir, et une caméra sur batterie n'est pas réveillée pour rien. Les images reprennent dès que le mode privé est désactivé.

Si une caméra ne propose pas cette fonction, l'interrupteur n'est simplement pas créé.

## Orienter une caméra motorisée (PTZ)

Les caméras motorisées (C200, C210, C225, C500…) peuvent être orientées depuis Gladys : les flèches apparaissent directement sur le widget caméra du tableau de bord, à côté de l'image.

Comme pour les événements, cela passe par ONVIF et demande donc que le **compte caméra** soit renseigné. L'intégration demande à chaque caméra ce qu'elle sait faire : une caméra qui pivote sans zoom motorisé n'affiche que les quatre flèches, et une caméra fixe n'affiche rien du tout. Vous n'avez aucune capacité à déclarer vous-même.

**Les positions enregistrées** que vous avez créées dans l'application Tapo sont reprises telles quelles, avec leurs noms. Elles apparaissent dans une liste déroulante sous les flèches, et sont utilisables dans une scène — c'est l'usage le plus courant : « quand je pars, oriente la caméra vers la porte ». Gladys ne crée ni ne renomme les positions : cela reste du ressort de l'application Tapo. Si vous en ajoutez une, elle apparaît au prochain scan.

Un appui sur une flèche déplace la caméra **d'un pas**, pas en continu. C'est délibéré : une commande envoyée depuis une scène, ou un appui dont le relâchement se perd, doit rester un petit mouvement et non plusieurs secondes de rotation. Par sécurité, tout mouvement continu est de toute façon arrêté automatiquement au bout de cinq secondes, même si Gladys perd le contact avec la caméra entre-temps.

Une remarque sur la vitesse : les firmwares Tapo ignorent largement la vitesse demandée et déduisent l'allure de la distance à parcourir. Un pas peut donc paraître lent — c'est le comportement de la caméra, pas un réglage manquant.

## Options

- **Qualité de l'image** — HD donne une image plus nette, SD est plus légère et plus rapide à capturer.
- **Adresses des caméras** — à remplir uniquement si le cloud ne remonte pas l'adresse locale d'une caméra. Une par ligne, sous la forme `nom|ip`.
- **Intervalle de vérification des événements** — la fréquence à laquelle l'intégration cherche une sonnerie ou un mouvement. Plus court, la réaction est plus rapide mais vos caméras sont davantage sollicitées. Ce réglage ne concerne que les caméras sans ONVIF : celles qui l'utilisent préviennent Gladys d'elles-mêmes, sans attendre.
- **Délai de capture** — le temps accordé à une caméra pour fournir une image.

L'action **Rafraîchir les images** force une nouvelle capture de toutes vos caméras, utile pour vérifier votre installation.

## En cas de problème

**« Connexion refusée »** — vérifiez l'e-mail et le mot de passe de votre compte Tapo. Si vous utilisez la validation en deux étapes sur votre compte TP-Link, elle empêche cette connexion.

**Une caméra est trouvée mais ne répond pas en local** — les logs de l'intégration indiquent précisément le cas rencontré : adresse inconnue, ou aucun port qui répond. Si le scan ne la localise pas (autre VLAN, broadcast filtré par votre routeur), saisissez son adresse dans le champ **Adresses des caméras** : elle est toujours prioritaire.

**Le widget affiche une erreur alors que la caméra répond** — si la caméra utilise le mode RTSP, assurez-vous que son compte caméra est bien renseigné. C'est la cause la plus fréquente : les logs affichent alors `TAPO_RTSP_ACCOUNT_MISSING`. Rappelez-vous que ce compte est propre à chaque caméra.

**Aucune image sur une sonnette sur batterie** — ces modèles se mettent en veille profonde pour économiser leur batterie et peuvent mettre plusieurs secondes à répondre. Augmentez le **délai de capture** si nécessaire.

**Le mouvement met du temps à remonter** — la caméra est probablement sur le chemin « interrogation ». Vérifiez que son **compte caméra** est renseigné : c'est ce qui permet à ONVIF de fonctionner, et donc au mouvement d'être immédiat. Les modèles sur batterie, eux, ne proposent pas ONVIF du tout.

**Aucun mouvement détecté sur une caméra ONVIF** — dans l'application Tapo, vérifiez que la détection de mouvement est activée et que le mode privé est désactivé : une caméra en mode privé ne signale plus rien.

**Caméras sans flux RTSP** — les modèles sur batterie et les sonnettes (C610, C425, D230…) n'exposent ni RTSP ni ONVIF. Ce n'est pas un obstacle : l'intégration bascule automatiquement sur le protocole propriétaire TP-Link, celui qu'utilise l'application Tapo, et récupère leurs images sans compte caméra. Seule différence : pas de flux vidéo direct pour ces caméras, uniquement des images rafraîchies régulièrement.

Ces caméras se réveillent parfois lentement : si la capture échoue avec un message de délai dépassé, augmentez le **délai de capture**.

## Vie privée

Vos identifiants Tapo sont stockés par Gladys et ne servent qu'à contacter le cloud TP-Link et vos caméras. Les images sont capturées sur votre réseau local et transmises directement à votre Gladys : elles ne passent par aucun serveur tiers.
