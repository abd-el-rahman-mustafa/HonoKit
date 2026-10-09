# Third-party notices

HonoKit is licensed under the GNU Affero General Public License 3.0 or later
([LICENSE](LICENSE)). It includes the following work by others. Versions are those of
the first release; `package-lock.json` is the exact record.

## Software

| Component | Version | Licence | Used for |
| --- | --- | --- | --- |
| [MuPDF](https://mupdf.com) (npm `mupdf`), Artifex Software | 1.28.1 | AGPL-3.0-or-later | Opening, rendering, reading, changing and saving PDF files |
| [pdf-lib](https://github.com/Hopding/pdf-lib) | 1.17.1 | MIT | Drawing watermarks and page numbers |
| [@pdf-lib/fontkit](https://github.com/Hopding/fontkit) | 1.1.1 | MIT | Shaping Arabic and embedding fonts |
| [bidi-js](https://github.com/lojjic/bidi-js) | 1.1.0 | MIT | The Unicode bidirectional algorithm, for mixed Arabic and Latin text |
| [Electron](https://www.electronjs.org) | 38 | MIT (includes Chromium and Node.js, each under its own licences) | The application shell |
| [electron-updater](https://github.com/electron-userland/electron-builder) | 6 | MIT | Updates from GitHub Releases |
| [React](https://react.dev), React DOM | 19 | MIT | The interface |
| [Zustand](https://github.com/pmndrs/zustand) | 5 | MIT | Interface state |
| [Zod](https://zod.dev) | 4 | MIT | Checking data between processes |
| [Lucide](https://lucide.dev) (`lucide-react`) | 0.544 | ISC | Icons |
| [clsx](https://github.com/lukeed/clsx) | 2 | MIT | Class names |
| [docx](https://github.com/dolanmiu/docx) | 9.8 | MIT | Writing Word files (PDF to Word) |
| [PptxGenJS](https://github.com/gitbrent/PptxGenJS) | 4.0 | MIT | Writing PowerPoint files (PDF to PowerPoint) |
| [ExcelJS](https://github.com/exceljs/exceljs) | 4.4 | MIT | Writing and reading Excel files (PDF to Excel, Create PDF) |
| [mammoth](https://github.com/mwilliamson/mammoth.js) | 1.13 | BSD-2-Clause | Reading Word files (Create PDF without Office) |
| [ONNX Runtime](https://github.com/microsoft/onnxruntime) (`onnxruntime-node`) | 1.30 | MIT | Running the text recognition and image AI models |
| [sharp](https://sharp.pixelplumbing.com) with [libvips](https://www.libvips.org) (`@img/sharp-win32-x64`) | 0.35.5 / 8.18 | Apache-2.0; libvips LGPL-3.0-or-later (and its bundled libraries' own licences) | Reading, editing and writing pictures (image tools, §69) |
| [ImageMagick](https://imagemagick.org) as WebAssembly (`@imagemagick/magick-wasm`), with libheif, libde265, LibRaw, libjxl, OpenJPEG, OpenEXR | 0.0.44 / 7.1.2 | Apache-2.0 wrapper; ImageMagick licence; LGPL (libheif, libde265, LibRaw also CDDL); BSD (libjxl, OpenJPEG, OpenEXR) — see the package's NOTICE | HEIC, camera RAW, PSD, JPEG XL, JPEG 2000 and other formats |
| [UPNG.js](https://github.com/photopea/UPNG.js) (`upng-js`) | 2.1 | MIT | Animated PNG |
| [exifr](https://github.com/MikeKovarik/exifr) | 7.1 | MIT | Reading camera details and location |
| [hunspell-asm](https://github.com/kwonoj/hunspell-asm), with [Hunspell](https://hunspell.github.io) compiled to WebAssembly | 4.0.2 | MIT wrapper; Hunspell MPL-1.1 / GPL-2.0-or-later / LGPL-2.1-or-later (tri-licence) | Spell check while editing |
| [node-forge](https://github.com/digitalbazaar/forge) | 1.4 | BSD-3-Clause (or GPL-2.0, at the user's choice) | Digital IDs (.pfx/.p12) and signing |
| [PKI.js](https://github.com/PeculiarVentures/PKI.js) and [ASN1.js](https://github.com/PeculiarVentures/ASN1.js) | 3.4 / 3.0 | BSD-3-Clause | Checking digital signatures |
| [@xmldom/xmldom](https://github.com/xmldom/xmldom) | 0.8 | MIT | Reading PowerPoint and Word XML |
| [JSZip](https://github.com/Stuk/jszip) | 3.10 | MIT (or GPL-3.0-or-later, at the user's choice) | Reading and writing Office files |

## Text recognition models

In `resources/ocr/`, used by Recognize text (OCR), Scan and picture to text.

| Model | Licence | Source |
| --- | --- | --- |
| PP-OCRv4 detector and recogniser, © PaddlePaddle Authors | Apache-2.0 | PaddleOCR, ONNX export from the `@gutenye/ocr-models` 1.4.2 package |
| PP-OCRv5 Arabic mobile recogniser, © PaddlePaddle Authors | Apache-2.0 | PaddleOCR, ONNX export by vladadu on Hugging Face (revision 047899f) |

## Image AI models

In `resources/ai/`, used by Upscale image, Remove background and Blur faces and licence plates. The licences are those the authors publish with the weights; the training data (research datasets) is not shipped.

| Model | Licence | Source (SHA-256) |
| --- | --- | --- |
| Real-ESRGAN realesr-general-x4v3, © Xintao Wang et al. | BSD-3-Clause | xinntao/Real-ESRGAN v0.2.5.0, ONNX by CoderViking on Hugging Face (1940a93e…f112) |
| U²-Net small (u2netp), © Xuebin Qin et al. | Apache-2.0 | rembg release v0.0.0 (309c8469…ddd8) |
| YuNet face detector 2026may, © OpenCV | MIT | opencv/opencv_zoo (ebafce4e…f0f0) |
| YOLOv9-t licence-plate detector, 384 px end-to-end, © ankandrew | MIT | ankandrew/open-image-models release "assets" (888397b9…77a8) |

## Fonts

Bundled so that stamped text looks the same everywhere and can be embedded in PDFs.

| Font | Licence | File |
| --- | --- | --- |
| IBM Plex Sans Arabic, © IBM Corp. | SIL Open Font License 1.1 | [resources/fonts/OFL-IBMPlexSansArabic.txt](resources/fonts/OFL-IBMPlexSansArabic.txt) |
| Noto Sans, © The Noto Project Authors | SIL Open Font License 1.1 | [resources/fonts/OFL-Noto.txt](resources/fonts/OFL-Noto.txt) |

## Spelling dictionaries

In `resources/spell/`, used by spell check while editing. Each folder holds its licence.

| Dictionary | Licence | File |
| --- | --- | --- |
| Arabic (Ayaspell / Hunspell-ar), © Mohamed Kebdani, Taha Zerrouki and contributors | GPL-2.0-or-later / LGPL-2.1-or-later / MPL-1.1 (tri-licence) | [resources/spell/ar/COPYING.txt](resources/spell/ar/COPYING.txt), [AUTHORS.txt](resources/spell/ar/AUTHORS.txt) |
| English (US) and English (UK), from SCOWL by Kevin Atkinson et al., via the `dictionary-en` and `dictionary-en-gb` packages | MIT and BSD-style (see the file) | [resources/spell/en-US/LICENSE.txt](resources/spell/en-US/LICENSE.txt), [resources/spell/en-GB/LICENSE.txt](resources/spell/en-GB/LICENSE.txt) |
| `names-en.txt`: place and personal names of the region, so they are not marked as mistakes | Part of HonoKit (AGPL-3.0-or-later) | [resources/spell/names-en.txt](resources/spell/names-en.txt) |
