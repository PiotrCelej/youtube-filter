# YouTube — tylko subskrypcje

Rozszerzenie do desktopowego Brave na **Windows i Linux**. Filtruje istniejące
rekomendacje na głównej stronie YouTube: pozostawia filmy, których autorzy są
na liście subskrybowanych kanałów. Zachowuje kolejność rekomendacji i adres strony
głównej; nie przekierowuje do widoku „Subskrypcje”. Pozostawia oryginalne kafelki
z miniaturami, tytułami i linkami do filmów. Układa je obok siebie bez pustych
miejsc po odrzuconych rekomendacjach. Pozostałe rekomendacje są całkowicie ukryte.

Pod rekomendacjami dodaje sekcję **Filmy z Twoich subskrypcji** z miniaturami:
wszystkie publikacje z ostatniego miesiąca dla każdego kanału albo jeden
najnowszy film, jeśli kanał nie publikował niczego w tym okresie.

## Instalacja

1. Pobierz i rozpakuj `dist/youtube-subscriptions-filter-1.1.1.zip` albo użyj
   bezpośrednio katalogu `extension` z tego projektu.
2. W Brave otwórz `brave://extensions`.
3. Włącz **Tryb programisty**.
4. Kliknij **Załaduj rozpakowane** / **Load unpacked**.
5. Wybierz folder zawierający `manifest.json`: `extension` albo folder
   rozpakowanego ZIP-a.
6. Odśwież otwarte karty YouTube i zaloguj się na swoje konto YouTube.
7. Przypnij rozszerzenie do paska narzędzi, aby mieć pod ręką przełącznik.

Aktualizacja z poprzedniej wersji: zastąp pliki w dotychczasowym katalogu
rozszerzenia, kliknij jego przycisk przeładowania w `brave://extensions`, a potem
odśwież kartę YouTube.

Wersja 1.1.1 naprawia odczyt publikacji: rozpoznaje identyfikator nagłówka RSS
bez prefiksu `UC` oraz aktualne kafelki `lockupViewModel` na listach filmów.

Wersja 1.0.2 naprawia błąd `Unexpected token` podczas odczytu konfiguracji
YouTube. Pomija dodatkowe bloki konfiguracji JavaScript, np.
`{"SERVICE_NAME": 'youtube'}`, i odczytuje właściwą konfigurację JSON potrzebną
do pobierania subskrypcji. Nie wykonuje kodu pobranego ze strony.

Instalacja jest taka sama na Windows i Linux. Nie wymaga Node.js, dodatkowego
programu, klucza YouTube API ani logowania do rozszerzenia. Katalog z rozszerzeniem
powinien pozostać na dysku w stałym miejscu.

Brave obsługuje rozszerzenia Chromium; projekt używa Manifest V3 i standardowych
API rozszerzeń. Zobacz [dokumentację Brave](https://support.brave.app/hc/en-us/articles/360017909112-How-can-I-add-extensions-to-Brave)
i [dokumentację skryptów treści Chromium](https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts).

## Korzystanie

- Filtr jest domyślnie **włączony**. Działa wyłącznie na `https://www.youtube.com/`
  i kanonicznym odpowiedniku bez `www`, także z parametrami adresu.
- Kliknij ikonę rozszerzenia i przełącz **Filtr rekomendacji**. Wyłączenie
  natychmiast odsłania kafelki, ukrywa dodatkową sekcję i przerywa jej pobieranie,
  bez odświeżania strony.
- Przełącznik działa we wszystkich kartach YouTube i pozostaje zapisany po
  restarcie przeglądarki. Ustawienie dotyczy profilu Brave, nie konta YouTube.
- Pasek na głównej pokazuje stan, liczbę kanałów i wynik filtrowania. Pozwala
  odświeżyć listę kanałów lub wyłączyć filtr.
- Po zmianie subskrypcji użyj **Odśwież kanały**. Lista jest też odświeżana przy
  powrocie na główną lub do karty, jeśli ostatni odczyt ma co najmniej 5 minut.
- Sekcja pod rekomendacjami pokazuje filmy od najnowszych, z tytułem, nazwą kanału
  i datą. Starszy film dodany z powodu braku nowych publikacji ma osobne oznaczenie.
- **Odśwież filmy** pobiera ponownie publikacje z aktualnie odczytanej listy
  kanałów. Stan pobierania i błędy poszczególnych kanałów są widoczne w sekcji.
- Wyniki wyszukiwania, odtwarzacz, strony kanałów i widok „Subskrypcje” zachowują
  zwykłą zawartość.

## Zachowanie i ograniczenia

Część z rekomendacjami zachowuje kolejność YouTube. Jeśli YouTube nie poleca
żadnego filmu z subskrypcji, ta część może być pusta. Osobna sekcja poniżej
pobiera publikacje niezależnie od rekomendacji, więc pokazuje również filmy,
których YouTube nie zaproponował na głównej. Ten sam film może występować
w rekomendacjach i w dodatkowej sekcji.

„Miesiąc” oznacza miesiąc kalendarzowy wstecz, z włączeniem dnia granicznego,
np. od 6 października do 6 listopada. Daty są porównywane w UTC; na końcu miesiąca
dzień jest dopasowywany do długości poprzedniego miesiąca. Dla każdego kanału
wybierane są wszystkie dostępne publikacje z tego okresu. Jeśli ich nie ma,
wybierany jest wyłącznie najnowszy starszy film. Kanał bez dostępnych publikacji
nie dodaje kafelka. Filmy z datą w przyszłości są pomijane.

Źródłem są publiczne kanały publikacji YouTube (RSS). Jeśli pierwszych 15 wpisów
nie obejmuje całego miesiąca albo RSS jest niedostępny, rozszerzenie odczytuje
playlistę publikacji kanału i jej kolejne strony. Brakujące dokładne daty
odczytuje z metadanych filmów. Nie wyznacza dat z zaokrąglonych etykiet typu
„miesiąc temu”. Publikacje mogą obejmować zwykłe filmy, Shorts i nagrania transmisji.
Pobieranie działa równolegle dla maksymalnie czterech kanałów; przy dużej liczbie
subskrypcji wyniki pojawiają się stopniowo.

Gdy odczyt filmów jednego kanału się nie powiedzie, sekcja zgłasza niepełną listę
i wskazuje kanał. Pozostałe kanały oraz filtr rekomendacji działają dalej. Błąd
kolejnej strony nie jest traktowany jako kompletny wynik dla danego kanału.

Autor jest weryfikowany po identyfikatorze kanału lub jego adresie, nigdy po samej
nazwie. Kafelki bez rozpoznawalnego autora, reklamy w obsługiwanych kafelkach,
zbiorcze sekcje Shorts i inne zbiorcze półki są ukrywane. Może to również ukryć film
subskrybowanego twórcy, jeśli YouTube nie udostępni jego adresu w kafelku.

Podczas pobierania listy lub w razie błędu rekomendacje pozostają ukryte, a pasek
wyświetla przyczynę. Rozszerzenie nie używa niepełnej listy, jeśli pobranie kolejnej
strony kanałów się nie powiedzie. Można ponowić odczyt lub wyłączyć filtr.

YouTube nie udostępnia rozszerzeniom publicznego API do odczytu subskrypcji bez
osobnego procesu OAuth. Ten projekt odczytuje dane strony `/feed/channels` i jej
kolejne strony z użyciem sesji YouTube. To wewnętrzny format YouTube, który może
się zmienić. Błąd odczytu jest sygnalizowany zamiast udawania poprawnego wyniku.
Po zmianie konta odśwież kartę YouTube, aby jednoznacznie odczytać nowe subskrypcje.

## Dane i uprawnienia

- Jedynym uprawnieniem API jest `storage`: zapisuje lokalnie stan przełącznika.
- Dostęp do stron jest ograniczony do HTTPS na `youtube.com` i `www.youtube.com`.
- Lista kanałów pozostaje w pamięci danej karty; nie jest zapisywana na dysku
  ani współdzielona między kontami. Po wyłączeniu filtra jest usuwana z pamięci
  rozszerzenia.
- Listy i metadane są pobierane z YouTube, a miniatury z jego serwera
  `i.ytimg.com`. Lista dodatkowych filmów pozostaje w pamięci karty.
  Rozszerzenie korzysta z istniejącej sesji;
  dla stronicowania oblicza podpis żądania z dostępnych ciasteczek sesyjnych
  YouTube. Nie zapisuje ani nie loguje ciasteczek i podpisów.
- Brak analityki, serwera pośredniczącego i zdalnie pobieranego kodu.

## Rozwój i weryfikacja

Do pracy nad projektem wystarczy Node.js 20+; nie ma zależności npm.

```sh
npm test
npm run pack
```

ZIP ma `manifest.json` w katalogu głównym i zawiera wyłącznie pliki rozszerzenia.
Pakowanie działa na Windows i Linux.

Test integracyjny wymaga Node.js 22+ (wbudowany WebSocket) i zainstalowanego Brave:

```sh
# Linux — dostosuj ścieżkę, jeśli Brave jest zainstalowany gdzie indziej
node scripts/browser-smoke.cjs /usr/bin/brave-browser
```

```powershell
# Windows
node scripts/browser-smoke.cjs 'C:\Program Files\BraveSoftware\Brave-Browser\Application\brave.exe'
```

Test uruchamia Brave bez okna z oddzielnym profilem w `.test-profile/`. Żądania
testowej karty YouTube zastępuje lokalnymi odpowiedziami. Wynik zapisuje do
`.test-output/browser-results.txt`. Nie korzysta z Twojego profilu ani konta.

Sprawdzane przypadki: dopasowanie kanałów, paginacja subskrypcji, brak autora,
reklamy i półki Shorts, dynamiczne dodawanie i ponowne użycie kafelków, nawigacja
YouTube bez przeładowania, przełącznik w panelu, zapis ustawienia, błędy sieci,
ponowienie odczytu i wyłączenie podczas pobierania.

Testy dodatkowej sekcji obejmują granice miesiąca i lata przestępne, dokładne
daty, wybór jednego starszego filmu, wykluczenie przyszłych dat, więcej niż
15 nowych publikacji kanału, stronicowanie, błędy pojedynczych kanałów,
ograniczenie równoległych żądań, miniatury, położenie pod rekomendacjami,
anulowanie pobierania i usuwanie sekcji po wyłączeniu filtra.

Automatyczna weryfikacja nie zastępuje sprawdzenia na zalogowanym koncie z
aktualnym układem YouTube. Przed publikacją należy wykonać taki test na Windows
i Linux, w tym dla konta z dużą liczbą subskrypcji i po przełączeniu konta.

## Pliki

- `extension/core.js` — parser danych i dopasowanie adresów kanałów.
- `extension/subscriptions.js` — odczyt i stronicowanie subskrypcji.
- `extension/uploads.js` — pobieranie publikacji i wybór filmów dla każdego kanału.
- `extension/uploads-view.js` — dodatkowa sekcja z miniaturami i stanem pobierania.
- `extension/content.js` i `content.css` — filtrowanie kafelków i pasek stanu.
- `extension/popup.*` — panel rozszerzenia.
- `tests/core.test.cjs` — testy parsera, tożsamości kanałów i pobierania.
- `tests/uploads.test.cjs` — testy dat, wyboru filmów i pobierania publikacji.
- `scripts/browser-smoke.cjs` — test w rzeczywistym Brave na kontrolowanych danych.
- `scripts/package.cjs` — tworzenie ZIP-a bez dodatkowych bibliotek.
