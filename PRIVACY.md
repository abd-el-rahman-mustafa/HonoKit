# Privacy

HonoKit works offline. It has no account, no telemetry and no analytics. Your documents and
pictures are opened, changed and saved on your own computer and are never sent anywhere. The
text recognition (OCR), the spelling dictionaries and the image AI models are part of the app
and run on your computer.

## The one connection it makes

HonoKit checks for new versions on GitHub Releases (`github.com` and
`objects.githubusercontent.com`) when it starts and every few hours. That request carries
only what any web request carries: your IP address and the app's version in the User-Agent.
Nothing about you or your files is sent. GitHub's
[General Privacy Statement](https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement)
applies to that request.

You can turn the check off in **Settings › Updates**; then HonoKit makes no network
connection at all, except when you choose **Check now**.

## Links you choose to open

These open in your web browser, and only when you click them:

- **Settings › About › Report a problem** opens a new issue form on GitHub with the app's
  version, your Windows version and the app's language filled in. You see everything before
  you send it, and nothing is sent unless you submit the form yourself.
- **Source code** and **Open download page** open the project's pages on GitHub.
- A web or email link inside a document opens only after HonoKit has shown you the whole
  address and you have agreed.

## Sharing

**Share** in HonoKit uses Windows' own share window, your mail app, the clipboard or a
folder on your computer — only when you choose it, and only with the apps you pick.

## Signed releases

Windows releases are to be code-signed through SignPath Foundation (see the README's "Code signing
policy"). Signing happens on SignPath's service from the published build; it does not involve
your computer or your documents.
