# Vault Theme

> _A minimal, readable theme for Obsidian built around my own preferences._

<!-- TODO: Add screenshots here. -->

## Installation

**Prerequisites:** [Git](https://git-scm.com) and [Node.js](https://nodejs.org) `24.2+`.

1. Clone the repository and install dependencies:

   ```sh
   git clone https://github.com/cs-schmidt/vault-theme.git
   cd vault-theme
   npm install
   ```

2. Build the theme into your vault's `themes` folder:

   ```sh
   npm run build -- --out-dir "<vault-path>/.obsidian/themes"
   ```

   This builds the theme folder within the provided path (See `node build.js -h` for
   usage).

3. In Obsidian, open **Settings → Appearance → Themes** and select it.

## Fonts

The theme doesn't bundle fonts. For the intended look, install these on your system:

| Area      | Fonts                                                                                                                  |
| --------- | ---------------------------------------------------------------------------------------------------------------------- |
| Interface | [IBM Plex Sans Condensed](https://fonts.google.com/specimen/IBM+Plex+Sans+Condensed)                                   |
| Text      | [Chivo](https://fonts.google.com/specimen/Chivo), \*_[IBM Plex Sans](https://fonts.google.com/specimen/IBM+Plex+Sans)_ |
| Code      | [Source Code Pro](https://fonts.google.com/specimen/Source+Code+Pro)                                                   |

\*IBM Plex Sans is used as both a fallback and patch for Chivo's incomplete/mismatched
Greek case pairs.

## Development

To rebuild automatically into your vault on every change:

1. Rename `.env.example` to `.env` and point `OUT_DIR` to your vault's `themes` folder.
2. Execute `npm run build:dev`.

> **NOTE:** `npm run build:dev` will ask before overwriting existing theme files; pass
> `--no-check` to skip the prompt (`npm run build:dev -- --no-check`).

## License

Released under the [MIT License](./LICENSE).

## Disclaimer

This theme is built for my personal use on Linux: it is not thoroughly tested across all
operating systems and setups. The software is provided as is, and may break with updates.
