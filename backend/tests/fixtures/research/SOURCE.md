# Research test documents

Two real, public-domain texts for the required real-engine G2 test
(`tests/integration/test_real_engine.py::test_g2_success_with_a_genuinely_sourced_document`).
Nothing in them is invented or edited. The test narration is written for the test, and each
of its claims is supported by a passage of these texts.

Both texts were retrieved on 2026-11-23 through the MediaWiki API (`action=parse` at the
revision below) and converted from HTML to plain text. The only changes:
- zero-width spaces (U+200B) from the wiki markup were removed;
- trailing whitespace was trimmed, and runs of spaces left by the removed zero-width spaces
  were collapsed to one;
- the text is NFC-normalised.

The test imports them offline with `research-add-document`. Nothing is fetched while testing.

## `tuyen-ngon-doc-lap-1945.vi.txt`

| | |
|---|---|
| Work | *Tuyên ngôn Độc lập* of the Democratic Republic of Viet Nam (Hồ Chí Minh; read in Hà Nội on 2 September 1945) |
| Edition | As printed in *Cứu Quốc* (the Việt Minh newspaper), no. 36, 5 September 1945, pages 1–2 |
| Transcription | Vietnamese Wikisource, page “Tuyên ngôn Độc lập Việt Nam”, revision 85294 (2020-08-14), transcluding `Trang:Cuu Quoc 5 Sep 1945.pdf/1` (revision 81062) and `/2` (revision 113837), a proofread transcription of the newspaper scan |
| URL | https://vi.wikisource.org/w/index.php?oldid=85294 |
| Excerpt | The full text of the declaration, from its title to the list of signatories. Wikisource's header and licence notices are not included. |
| SHA-256 | `a82605db4a2f836a0ae3b724250ab15f2374a0cdefd131bf0b20388657057538` |
| Licence | Public domain. Wikisource marks the page `PVCC-CPVN` (an official document of a Vietnamese state body, not protected under the Law on Intellectual Property, Article 15(2)) and `PVCC-VN` (the term of protection has expired in Viet Nam). |
| Attribution | Hồ Chí Minh and the Provisional Government of the Democratic Republic of Viet Nam; transcription by Vietnamese Wikisource contributors |

## `us-declaration-1776-preamble.en.txt`

| | |
|---|---|
| Work | *United States Declaration of Independence*, adopted by the Second Continental Congress on 4 July 1776 (written primarily by Thomas Jefferson) |
| Edition | The copy engrossed on parchment by Timothy Matlack (1776), held by the U.S. National Archives |
| Transcription | English Wikisource, page “United States Declaration of Independence (engrossed copy)”, revision 16143344 (2026-07-18), transcluding `Page:United States Declaration of Independence.jpg/1` |
| URL | https://en.wikisource.org/w/index.php?oldid=16143344 |
| Excerpt | The opening: from “When in the Course of human events” to “the pursuit of Happiness.”, verbatim, including the transcription's line-filler underscores |
| SHA-256 | `18f126ddbe2fb0f90682de5eff3998f5748d03ccdc4f9bb2e6c12f3d0f3cf34e` |
| Licence | Public domain (Wikisource `PD-old`) |
| Attribution | The Second Continental Congress; transcription by English Wikisource contributors |

## Why these two

The 1945 declaration opens by quoting the 1776 one in Vietnamese translation: “Tất cả mọi
người đều sinh ra bình đẳng” renders “all men are created equal”. So the test can trace a
real translated quotation to its original passage in another imported document, which the
engine requires before a translated quotation can be verified.
