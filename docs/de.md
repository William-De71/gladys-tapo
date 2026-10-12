# Tapo-Integration für Gladys Assistant

Diese Integration fügt Ihre **TP-Link Tapo**-Geräte zu Gladys hinzu: Kameras und Türklingeln (Bild im Dashboard, Klingeln und Bewegungen als Auslöser für Szenen, Akkustand), aber auch Steckdosen, Steckdosenleisten, Lampen, Schalter und die Sensoren des H100-Hubs – siehe [Steckdosen, Lampen, Schalter und Sensoren](#steckdosen-lampen-schalter-und-sensoren).

## Funktionsweise

Zwei Kanäle, jeder für das, was er am besten kann:

- **Die TP-Link-Cloud** liefert die Liste Ihrer Kameras. Es ist dasselbe Konto wie in der Tapo-App. Die lokale Adresse der Kameras teilt sie jedoch **nicht** mit.
- **Ein Scan Ihres Netzwerks** findet anschließend jede Kamera, genau wie die Tapo-App beim Start. In den meisten Installationen müssen Sie dadurch keine IP-Adresse eingeben (siehe [Die IP-Adresse Ihrer Kameras](#die-ip-adresse-ihrer-kameras), wenn es doch nötig ist).
- **Ihr lokales Netzwerk** liefert alles Weitere: Bilder, Klingel, Bewegung, Akku. Nichts davon läuft über die Cloud: Gladys spricht direkt mit der Kamera, bei Ihnen zu Hause.

Für die Bildaufnahme wählt die Integration automatisch einen von zwei Modi, je nachdem, was die Kamera unterstützt:

| Modus          | Wann er verwendet wird                              | Was er voraussetzt                         |
| -------------- | --------------------------------------------------- | ------------------------------------------ |
| **RTSP**       | Die Kamera bietet einen RTSP-Stream an (Port 554)   | Ein in der Tapo-App erstelltes Kamerakonto |
| **Proprietär** | Die Kamera bietet keinen RTSP-Stream an (Port 8800) | Nichts außer Ihrem Tapo-Konto              |

Der zweite Modus ist das interne Protokoll von TP-Link, das auch die mobile App verwendet. Damit lässt sich ein Bild von den Modellen abrufen – oft akkubetriebenen –, die keinen Standard-Stream anbieten.

## Einrichtung

### 1. Ihr Tapo-Konto eingeben

Geben Sie im Bildschirm **Konfiguration** der Integration die E-Mail-Adresse und das Passwort Ihres TP-Link-/Tapo-Kontos ein und wählen Sie dann die nächstgelegene Cloud-Region (standardmäßig Europa).

### 2. Ein Kamerakonto erstellen (empfohlen)

Wenn Ihre Kameras kabelgebunden sind (C100, C200, C210, C500…), ist RTSP der bessere Modus: leichter und robuster. Er setzt ein in der Tapo-App erstelltes Kamerakonto voraus:

1. Öffnen Sie die Tapo-App und wählen Sie Ihre Kamera aus.
2. Gehen Sie zu **Kameraeinstellungen** → **Erweiterte Einstellungen** → **Kamerakonto**.
3. Legen Sie einen Benutzernamen und ein Passwort fest.
4. Übernehmen Sie diese in den Abschnitt **Kamerakonto (RTSP und ONVIF)** der Gladys-Konfiguration.

Achtung: Dieses Kamerakonto ist **nicht** Ihr Tapo-Konto, und es wird **für jede Kamera einzeln** erstellt. Es gibt zwei Möglichkeiten, es einzutragen:

- wenn Sie auf allen Kameras **dieselben Zugangsdaten** verwendet haben, füllen Sie einfach die Felder **Benutzername / Passwort des Standardkontos** aus;
- andernfalls verwenden Sie, sobald die Kameras hinzugefügt sind (Schritt 3), die Aktion **Kamerakonto speichern** unten im Bildschirm Konfiguration: Wählen Sie die Kamera in der Liste aus, geben Sie Benutzernamen und Passwort ein und führen Sie die Aktion aus. Gladys versucht sofort eine Aufnahme und teilt Ihnen mit, ob das Konto funktioniert. Wiederholen Sie dies für jede Kamera.

Konten pro Kamera haben Vorrang vor dem Standardkonto und bleiben der Kamera zugeordnet, auch wenn Sie sie umbenennen. Wenn Sie alles leer lassen, verwendet die Integration für jede Kamera den proprietären Modus.

Das Feld **Konten pro Kamera (erweitert)** akzeptiert weiterhin eine eingetippte Liste (`name|benutzername|passwort`, durch Kommas getrennt), die Aktion ist aber einfacher und akzeptiert jedes Passwort, auch mit Kommas.

Bei manchen Modellen müssen Sie außerdem die **Drittanbieter-Kompatibilität** aktivieren (in der Tapo-App unter _Ich_ → _Tapo Lab_), bevor der RTSP-Stream erreichbar ist.

### 3. Einen Scan starten

Klicken Sie auf **Verbindung testen**: Gladys meldet sich bei der Cloud an, scannt Ihr Netzwerk und zeigt **eine Zeile pro Kamera** an – ihre Adresse, woher diese Adresse stammt und wie das Bild aufgenommen wird:

```
Mit der Tapo-Cloud verbunden: 3 Gerät(e), 2 in Ihrem Netzwerk erreichbar.
✔ Wohnzimmer (C230): 192.168.1.20 (im Netzwerk gefunden), Bilder über RTSP
✔ Garage (C210): 192.168.1.21 (im Netzwerk gefunden), Bilder über RTSP
✖ Garten (C660): nicht in Ihrem Netzwerk gefunden → verwenden Sie unten „IP-Adresse eines Geräts festlegen“.
```

Gehen Sie anschließend zum Bildschirm **Entdecken** und starten Sie einen Scan. Ihre Kameras erscheinen dort und können hinzugefügt werden. Sobald sie erstellt sind, fügen Sie Ihrem Dashboard das Widget **Kamera** hinzu.

Wenn eine Kamera mit ✖ markiert ist, lesen Sie weiter.

## Die IP-Adresse Ihrer Kameras

Um die Bilder abzurufen, benötigt Gladys die **lokale IP-Adresse** jeder Kamera (zum Beispiel `192.168.1.42`). Die TP-Link-Cloud liefert sie nicht: Die Integration findet sie durch einen Scan Ihres Netzwerks und erkennt jede Kamera an ihrer MAC-Adresse.

### Wenn der Scan eine Kamera nicht findet

Das passiert, wenn sich die Kamera in einem **anderen Subnetz oder VLAN** als Gladys befindet oder wenn Ihr Router **Broadcast-Verkehr filtert**. Die Lösung:

1. Öffnen Sie in der Tapo-App die Kamera, dann **Einstellungen** (Zahnradsymbol) → **Geräteinformationen**: Dort wird die **IP-Adresse** angezeigt.
2. Scrollen Sie in Gladys im Bildschirm **Konfiguration** der Integration nach unten bis zur Aktion **IP-Adresse eines Geräts festlegen**.
3. Wählen Sie die Kamera in der Liste aus, geben Sie ihre Adresse ein und führen Sie die Aktion aus.

Gladys prüft sofort, ob unter dieser Adresse etwas antwortet, nimmt ein Bild auf und teilt Ihnen mit, ob alles funktioniert. Die Adresse ist der Kamera selbst zugeordnet: Sie bleibt gültig, wenn Sie die Kamera umbenennen, in Gladys oder in der Tapo-App.

Um zur automatischen Erkennung zurückzukehren, führen Sie die Aktion erneut mit einer **leeren** Adresse aus.

> **Tipp** – reservieren Sie die Adresse jeder Kamera in Ihrem Router („DHCP-Reservierung“ oder „statische Zuweisung“). Andernfalls kann der Router ihr nach einem Ausfall eine andere zuweisen, und eine eingegebene Adresse wäre dann falsch.

### Und die Cloud, ohne IP-Adresse?

Nicht möglich. TP-Link bietet Drittanwendungen **keine Möglichkeit**, das Bild oder den Stream einer Kamera über das Internet abzurufen: Die Tapo-App nutzt Relay-Server, die ihr selbst vorbehalten sind. Alle existierenden Integrationen – auch die von Home Assistant – arbeiten deshalb über das lokale Netzwerk, was zugleich garantiert, dass Ihre Bilder Ihr Zuhause nie verlassen.

### Das Feld „Manuelle Adressen (erweitert)“

Es ist weiterhin vorhanden, um Adressen von Hand einzugeben: durch Kommas getrennte Einträge, jeweils als `name|ip` (oder `name=ip`), zum Beispiel `Gartenkamera|192.168.1.42, Wohnzimmer|192.168.1.43`. Der Name wird ohne Rücksicht auf Groß-/Kleinschreibung, Akzente, Leerzeichen oder Unterstriche abgeglichen und kann auch die MAC-Adresse der Kamera sein. Die oben beschriebene Aktion bleibt sicherer: kein Name abzuschreiben, und die Adresse wird geprüft.

## Was Akkukameras können – und was nicht

Akku- und Solarmodelle (C610, C425, D230…) bieten weder RTSP noch ONVIF an: Sie sprechen nur das proprietäre Protokoll von TP-Link. Das hat zwei praktische Folgen.

### Kein Live-Video

Diese Kameras zeigen **regelmäßig aktualisierte Bilder**, keinen fortlaufenden Stream. Die Live-Ansicht von Gladys beruht auf einer URL, die an ffmpeg übergeben wird, und eine proprietäre Sitzung ist verschlüsselt und wird von der Integration selbst gesteuert – sie lässt sich nicht als URL ausdrücken. Kabelgebundene RTSP-Kameras erhalten dagegen Live-Video.

Das ist eine Grenze des Protokolls und nicht der Integration: Kein Werkzeug kann bei diesen Modellen mehr, außer über ein externes Relay wie go2rtc.

### Der Akku wird automatisch geschützt

Ein Bild aufzunehmen ist mit Abstand das Anspruchsvollste, was man von einer Kamera verlangt. Bei einem Solarmodell entleert zu häufiges Aufnehmen den Akku schneller, als das Panel ihn wieder auflädt – und eine zu tief entladene Lithiumzelle kann die Ladung ganz verweigern, was sich aus der Ferne nicht beheben lässt.

Die Integration nimmt sich daher von selbst zurück:

| Akku                   | Automatische Aktualisierung | Widget, Szene, Klingel |
| ---------------------- | --------------------------- | ---------------------- |
| über 60 %              | ja                          | ja                     |
| zwischen 40 % und 60 % | pausiert                    | ja                     |
| unter 40 %             | pausiert                    | nein                   |

Eine Kamera, die unter die erste Schwelle gefallen ist, nimmt den Betrieb erst bei **80 %** wieder auf, bewusst deutlich über der Pausenschwelle: Knapp darüber wieder zu starten würde die Entladung sofort neu beginnen lassen, und wiederholte flache Zyklen verschleißen den Akku schneller als ein richtiger Zyklus. Setzen Sie diesen Wert nicht auf 100 %: Eine Solarkamera lädt in Schüben und meldet selten genau voll, sodass sie dauerhaft pausiert bliebe.

Der Akkustand und die Ereignisse werden in jedem Fall weiter gelesen: Sie kosten fast nichts, und an ihnen erkennt man, wann die Kamera wieder aufgeladen ist.

Eine Akkukamera, die **nicht mehr antwortet** – Tiefschlaf, abgelehnte Sitzung, Netzwerk ausgefallen –, wird ebenfalls auf Abruf zurückgestuft: Ihrem zuletzt bekannten Stand kann man nicht mehr trauen, und eine stumme Kamera ist eher leer als in Ordnung.

### Ein eigenes Aufnahmeintervall

Akkukameras haben ein **eigenes Aktualisierungsintervall**, unabhängig von den kabelgebundenen. Die Aufnahmen eines Solarmodells seltener zu machen, kostet die Aktualität Ihrer netzbetriebenen Kameras also nichts.

| Einstellung                              | Standard        | Gilt für                   |
| ---------------------------------------- | --------------- | -------------------------- |
| Bildaktualisierungsintervall             | 60 s            | nur kabelgebundene Kameras |
| Aktualisierungsintervall für Akkukameras | 900 s (15 Min.) | Akku-/Solarmodelle         |

Das ist die mit Abstand wirksamste Einstellung: Was den Akku belastet, ist **das Aufwecken der Kamera**, weit mehr als das Bild selbst. Verlängern Sie im Winter oder wenn Ihr Panel wenig Sonne bekommt dieses Intervall und erhöhen Sie die Pausenschwelle.

## Erstellte Funktionen

Jede Kamera wird zu einem Gerät in Gladys:

- **Bild** – das vom Kamera-Widget angezeigte Bild, bei Bedarf aktualisiert.
- **Klingel** – ein Druck auf die Taste, als Auslöser für Szenen nutzbar.
- **Bewegung** – Bewegungserkennung, ebenfalls als Auslöser nutzbar.
- **Aktiviert** – Privatmodus: siehe [Privatmodus](#privatmodus).
- **Aufnahme** – eine Taste, um sofort ein Bild anzufordern (Akkumodelle, die seltener aktualisiert werden).
- **Bewegen** und **Position** – bei motorisierten Kameras: siehe [PTZ](#eine-motorisierte-kamera-ausrichten-ptz).
- **Akku** – der verbleibende Stand in Prozent (Akkumodelle).

Wenn jemand klingelt, nimmt die Integration sofort ein Bild auf und sendet es an Gladys: Das Widget zeigt den Besucher bereits, wenn Sie die Benachrichtigung öffnen.

### Wie Ereignisse Gladys erreichen

Zwei mögliche Wege, die für jede Kamera automatisch gewählt werden:

| Weg         | Funktionsweise                                          | Verzögerung            |
| ----------- | ------------------------------------------------------- | ---------------------- |
| **ONVIF**   | Die Kamera meldet Gladys sofort, wenn sie etwas erkennt | nahezu sofort          |
| **Abfrage** | Gladys fragt die Kamera regelmäßig, was sie erkannt hat | bis zu einem Intervall |

ONVIF ist zum Auslösen einer Szene klar vorzuziehen: Eine Bewegung kommt innerhalb einer Sekunde an, statt auf die nächste Prüfung zu warten. Dafür muss nur das **Kamerakonto** eingetragen sein – ONVIF verwendet diese Zugangsdaten, nicht Ihr Tapo-Konto.

Es ist außerdem der einzige Weg, der das **Ende** einer Bewegung meldet: Der Sensor fällt zurück, wenn die Kamera es sagt, statt nach einer festen Verzögerung.

Kabelgebundene Kameras (C210, C200, C500…) bieten in der Regel ONVIF an, was ihnen einen Bewegungssensor verschafft, den sie vorher nicht hatten. Akkumodelle bieten es nicht an und bleiben bei der Abfrage: Das ist kein Problem, ihre Erkennungen kommen weiterhin an, nur mit leichter Verzögerung.

Es gibt nichts zu konfigurieren: Wenn das Kamerakonto eingetragen ist und die Kamera ONVIF akzeptiert, nutzt die Integration es; andernfalls fragt sie die Kamera wie bisher ab.

## Privatmodus

Jede Kamera erhält ein Steuerelement **Aktiviert** – den Standard-Privatmodus von Gladys für Kameras (Gladys 5.0 oder neuer). Schalten Sie es aus, und Gladys hört überall auf, das Bild dieser Kamera aufzunehmen, anzuzeigen und zu speichern: Dashboard, Chat, Szenen. Es ist in einer Szene nutzbar – „wenn wir nach Hause kommen, die Wohnzimmerkamera ausschalten“.

Bei Tapo-Kameras mit einem **Privatsphäre-Modus** (das Objektiv wird physisch abgedeckt) steuert das Element auch diesen: Das Ausschalten der Kamera deckt das Objektiv ab, das Wiedereinschalten gibt es frei. Das läuft über denselben lokalen Kanal wie der Akkustand: kein Kamerakonto nötig, und Akkumodelle erhalten es ebenfalls. Es funktioniert **in beide Richtungen** – ein in der Tapo-App umgeschalteter Privatsphäre-Modus erscheint in Gladys bei der nächsten Prüfung, innerhalb einer Minute.

Bei einer Kamera ohne Privatsphäre-Modus wirkt das Element nur auf der Seite von Gladys: Die Kamera läuft weiter, Gladys lässt sie lediglich in Ruhe.

Solange eine Kamera ausgeschaltet ist, wird eine Akkukamera nicht unnötig geweckt, und das Widget zeigt an, dass die Kamera deaktiviert ist, statt eines alten Bildes.

> **Wenn Sie von Version 1.2 oder älter kommen** – der Privatsphäre-Modus war früher ein separater **Schalter**. Er funktioniert auf Ihren bestehenden Kameras weiter, Ihre Szenen bleiben also intakt. Wenn Sie eine Kamera über den Bildschirm **Entdecken** aktualisieren, wird der Schalter durch das Element **Aktiviert** ersetzt: Passen Sie die Szenen an, die den Schalter verwendet haben (Achtung, die Werte sind umgekehrt – der Schalter war „an“, wenn das Objektiv abgedeckt war, das Element ist „an“, wenn die Kamera aktiv ist).

## Eine motorisierte Kamera ausrichten (PTZ)

Motorisierte Kameras (C200, C210, C225, C500…) lassen sich von Gladys aus ausrichten: Die Pfeile erscheinen direkt im Kamera-Widget des Dashboards, neben dem Bild.

Wie die Ereignisse läuft das über ONVIF und setzt daher voraus, dass das **Kamerakonto** eingetragen ist. Die Integration fragt jede Kamera, was sie kann: Eine Kamera, die schwenkt, aber keinen motorisierten Zoom hat, zeigt nur die vier Pfeile, und eine feste Kamera zeigt gar nichts. Sie müssen keine Fähigkeiten angeben.

**Die gespeicherten Positionen**, die Sie in der Tapo-App angelegt haben, werden unverändert mit ihren Namen übernommen. Sie erscheinen in einer Auswahlliste unter den Pfeilen und können in einer Szene verwendet werden – die mit Abstand häufigste Nutzung: „wenn ich gehe, die Kamera auf die Tür richten“. Gladys legt keine Positionen an und benennt keine um: Das bleibt in der Tapo-App. Wenn Sie eine hinzufügen, erscheint sie beim nächsten Scan.

Ein Druck auf einen Pfeil bewegt die Kamera **um einen Schritt**, nicht fortlaufend. Das ist beabsichtigt: Ein aus einer Szene gesendeter Befehl oder ein Druck, dessen Loslassen verloren geht, soll eine kleine Bewegung bleiben und nicht mehrere Sekunden Drehung. Jeder Schritt endet daher von selbst: Selbst wenn Gladys gleich danach den Kontakt zur Kamera verliert, läuft keine Bewegung weiter.

Ein Hinweis zur Geschwindigkeit: Tapo-Firmwares ignorieren die angeforderte Geschwindigkeit weitgehend und leiten das Tempo aus der zurückzulegenden Strecke ab. Ein Schritt kann sich daher langsam anfühlen – das ist das Verhalten der Kamera, keine fehlende Einstellung.

## Steckdosen, Lampen, Schalter und Sensoren

Neben den Kameras unterstützt die Integration die anderen Tapo-Geräte Ihres Kontos. Sie erscheinen wie die Kameras im Bildschirm **Entdecken** und verwenden **Ihr Tapo-Konto**: Es muss kein zusätzliches Konto erstellt werden.

| Gerät                  | Beispiele                          | In Gladys                                            |
| ---------------------- | ---------------------------------- | ---------------------------------------------------- |
| Steckdose              | P100, P105, P115                   | Ein/Aus                                              |
| Steckdose mit Messung  | P110, P110M, P115                  | Ein/Aus, Leistung (W), Energie (kWh)                 |
| Steckdosenleiste       | P300, P304M, P306                  | Ein Gerät pro Steckplatz, jeder einzeln schaltbar    |
| Lampe, Lichtstreifen   | L510, L530, L630, L900, L920, L930 | Ein/Aus, Helligkeit, Farbe und Weiß (je nach Modell) |
| Wandschalter           | S500, S505 / S500D, S505D          | Ein/Aus / Dimmer (Helligkeit)                        |
| Sensoren des H100-Hubs | T310, T315                         | Temperatur, Luftfeuchtigkeit                         |
|                        | T100                               | Bewegung                                             |
|                        | T110                               | Öffnung (Tür, Fenster)                               |
|                        | T300                               | Wasserleck                                           |
|                        | S200B, S200D                       | Taste: Einfachklick, Doppelklick                     |
|                        | KE100                              | Temperatur und Sollwert des Heizkörperventils        |

Jeder Hub-Sensor wird zu einem eigenen Gerät, mit einer Warnung bei schwachem Akku (und dem Akkustand, wenn der Sensor ihn meldet). Die Fähigkeiten werden **beim Gerät abgefragt**, nie aus dem Modell erraten: Eine Lampe erhält nur dann eine Farbsteuerung, wenn sie Farben kann.

### So funktioniert es

Diese Geräte benachrichtigen Gladys nicht von selbst: Die Integration liest sie regelmäßig aus, im Takt der Option **Leseintervall für Steckdosen, Lampen und Sensoren** (standardmäßig 5 Sekunden). Ein Tastendruck oder eine sich öffnende Tür erreicht Gladys daher beim nächsten Auslesen. Ein Auslesen pro physischem Gerät genügt: Ein Hub mit zehn Sensoren kostet eine einzige Anfrage. Nur **Werte, die sich ändern**, werden an Gladys gesendet.

Der Austausch ist **lokal**, mit dem Protokoll, das die Tapo-App verwendet (KLAP bei neueren Firmwares, die ältere Verschlüsselung bei den anderen – automatisch gewählt). Die IP-Adresse stammt wie bei den Kameras aus dem Netzwerkscan; andernfalls verwenden Sie die Aktion **IP-Adresse eines Geräts festlegen** (bei einem Sensor zählt die Adresse seines **Hubs**).

### Energie der Steckdosen mit Messung

Die Steckdosen melden den Verbrauch des Tages, der jede Nacht zurückgesetzt wird. Die Integration macht daraus einen **Zähler, der nur steigt** (kWh), so wie es die Energieüberwachung von Gladys erwartet. Eine Einschränkung: Was verbraucht wird, während die Integration gestoppt ist, wird nicht gezählt.

### Noch nicht unterstützt

- der **H200-Hub** (er spricht das Protokoll der Kameras);
- die älteren **Kasa**-Geräte („IOT“-Protokoll) und **Saugroboter**;
- die an einen Hub gekoppelten Funkschalter **S210 / S220**.

Sie werden in **Verbindung testen** und in den Protokollen genannt, statt stillschweigend ignoriert zu werden.

## Optionen

- **Bildqualität** – HD liefert ein schärferes Bild, SD ist leichter und schneller aufzunehmen.
- **Manuelle Adressen (erweitert)** – siehe [Die IP-Adresse Ihrer Kameras](#die-ip-adresse-ihrer-kameras); die Aktion **IP-Adresse eines Geräts festlegen** ist einfacher.
- **Leseintervall für Steckdosen, Lampen und Sensoren** – wie oft diese Geräte ausgelesen werden (standardmäßig 5 s); siehe [So funktioniert es](#so-funktioniert-es).
- **Prüfintervall für Ereignisse** – wie oft die Integration nach einem Klingeln oder einer Bewegung sucht. Kürzer reagiert schneller, spricht aber häufiger mit Ihren Kameras. Diese Einstellung betrifft nur Kameras ohne ONVIF: Diejenigen, die es nutzen, melden sich selbst bei Gladys, ohne Wartezeit.
- **Aufnahme-Zeitlimit** – wie viel Zeit eine Kamera bekommt, um ein Bild zu liefern.

Die Aktion **Bilder aktualisieren** erzwingt eine neue Aufnahme aller Kameras, praktisch, um Ihre Einrichtung zu überprüfen.

## Fehlerbehebung

**„Verbindung abgelehnt“** – prüfen Sie die E-Mail-Adresse und das Passwort Ihres Tapo-Kontos. Die Zwei-Faktor-Authentifizierung Ihres TP-Link-Kontos verhindert diese Anmeldung.

**Das Widget bleibt leer, die Protokolle zeigen `TAPO_CAMERA_IP_UNKNOWN`** – Gladys kennt die Adresse der Kamera nicht: Der Scan hat sie nicht gefunden. Führen Sie **Verbindung testen** aus, um zu sehen, welche Kameras betroffen sind, und folgen Sie dann [Wenn der Scan eine Kamera nicht findet](#wenn-der-scan-eine-kamera-nicht-findet).

**Eine Kamera hat eine Adresse, antwortet aber nicht** – **Verbindung testen** kennzeichnet sie mit ⚠ und gibt an, woher die Adresse stammt. Prüfen Sie, ob die Kamera eingeschaltet ist, sich im selben Netzwerk wie Gladys befindet und ob die **Drittanbieter-Kompatibilität** in der Tapo-App aktiviert ist. Wenn sich die Adresse geändert hat (keine DHCP-Reservierung), korrigieren Sie sie mit der Aktion **IP-Adresse eines Geräts festlegen**.

**Das Widget zeigt einen Fehler, obwohl die Kamera antwortet** – wenn die Kamera RTSP verwendet, stellen Sie sicher, dass ihr Kamerakonto eingetragen ist. Das ist mit Abstand die häufigste Ursache: Die Protokolle zeigen dann `TAPO_RTSP_ACCOUNT_MISSING`. Denken Sie daran, dass dieses Konto für jede Kamera eigen ist.

**Kein Bild von einer Akku-Türklingel** – diese Modelle gehen in den Tiefschlaf, um ihren Akku zu schonen, und können mehrere Sekunden zum Antworten brauchen. Erhöhen Sie bei Bedarf das **Aufnahme-Zeitlimit**.

**Bewegungen kommen verzögert an** – die Kamera nutzt höchstwahrscheinlich den Abfrageweg. Prüfen Sie, ob ihr **Kamerakonto** eingetragen ist: Es ermöglicht ONVIF und damit sofortige Bewegungsmeldungen. Akkumodelle bieten überhaupt kein ONVIF an.

**Keine Bewegung bei einer ONVIF-Kamera erkannt** – prüfen Sie in der Tapo-App, ob die Bewegungserkennung aktiviert und der Privatsphäre-Modus ausgeschaltet ist: Eine Kamera im Privatsphäre-Modus meldet gar nichts.

**Kameras ohne RTSP-Stream** – Akkumodelle und Türklingeln (C610, C425, D230…) bieten weder RTSP noch ONVIF an. Das ist kein Hindernis: Die Integration weicht automatisch auf das proprietäre Protokoll von TP-Link aus, das die Tapo-App verwendet, und nimmt ihre Bilder ohne Kamerakonto auf. Der einzige Unterschied: kein Live-Video für diese Kameras, nur regelmäßig aktualisierte Bilder.

Sie wachen manchmal langsam auf: Wenn eine Aufnahme mit einer Zeitüberschreitung fehlschlägt, erhöhen Sie das **Aufnahme-Zeitlimit**.

## Datenschutz

Ihre Tapo-Zugangsdaten werden von Gladys gespeichert und nur verwendet, um die TP-Link-Cloud und Ihre Kameras zu erreichen. Die Bilder werden in Ihrem lokalen Netzwerk aufgenommen und direkt an Ihr Gladys gesendet: Sie laufen nie über einen Server eines Drittanbieters.
