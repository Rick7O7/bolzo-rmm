#!/usr/bin/env bash
# BOLZO RMM – Server-Installation und Update (Debian/Ubuntu mit systemd)
#   curl -fsSL https://raw.githubusercontent.com/Rick7O7/bolzo-rmm/main/install.sh | sudo bash
# Erneut ausführen = Update. Daten, Clients und Passwort bleiben erhalten.
set -euo pipefail

REPO_URL="${BOLZO_RMM_REPO:-https://github.com/Rick7O7/bolzo-rmm.git}"
BRANCH="${BOLZO_RMM_BRANCH:-main}"
SRC_DIR="/opt/bolzo-rmm-src"

if [[ -t 1 ]] && command -v tput >/dev/null 2>&1 && [[ "$(tput colors 2>/dev/null || echo 0)" -ge 8 ]]; then
  BOLD="$(tput bold)"; RESET="$(tput sgr0)"; RED="$(tput setaf 1)"; GREEN="$(tput setaf 2)"; YELLOW="$(tput setaf 3)"; CYAN="$(tput setaf 6)"
else
  BOLD=""; RESET=""; RED=""; GREEN=""; YELLOW=""; CYAN=""
fi

print_banner() {
  printf "%s
" "${CYAN}${BOLD}"
  cat <<'ASCII'
     ::::::::::::::::::::.           .:::::::::::::::       :::::                  ::::::::::::::::::::::::      ::::::::::::::::
    ::::::::::::::::::::::::      ::::::::::::::::::::::    :::::                  :::::::::::::::::::::::::  ::::::::::::::::::::::
    :::::::::::::::::::::::::   ::::::::::::::::::::::::::  :::::                  ::::::::::::::::::::::::.::::::::::::::::::::::::::
    ::::::              :::::  :::::::::::          ::::::: :::::                                  ::::::: :::::::            :::::::::
    ::::::              :::::  ::::: :::::::          :::::::::::                                :::::::   :::::           :::::::::::::
    ::::::             :::::: ::::::   :::::::         ::::::::::                              :::::::    ::::::         ::::::::  :::::
    :::::: :::::::::::::::::  ::::::    ::::::::       ::::::::::                            ::::::::     ::::::       ::::::::    :::::
    :::::: :::::::::::::::::: ::::::      ::::::::     ::::::::::                           :::::::       ::::::     ::::::::      :::::
    :::::: :::::::::::::::::::::::::        ::::::::   ::::::::::                         :::::::         ::::::   ::::::::        :::::
    ::::::               :::::::::::          ::::::: :::::::::::                       :::::::           :::::: ::::::::          :::::
    ::::::                ::::::::::            :::::::::::::::::                     ::::::::             ::::::::::::           ::::::
    ::::::                ::::::::::::            ::::::::: :::::                    :::::::               :::::::::            :::::::
    ::::::::::::::::::::::::::: ::::::::::::::::::::::::::  ::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::
    ::::::::::::::::::::::::::    ::::::::::::::::::::::    ::::::::::::::::::::::::::::::::::::::::::::::::  ::::::::::::::::::::::
      :::::::::::::::::::::           ::::::::::::::          ::::::::::::::::::::::::::::::::::::::::::::::      ::::::::::::::
ASCII
  printf "%s
" "${RESET}"
}

log_step() { STEP=$((STEP + 1)); printf "%s[%s/%s]%s %s
" "${CYAN}${BOLD}" "${STEP}" "${TOTAL_STEPS}" "${RESET}" "$1"; }
log_ok() { printf "%s[OK]%s %s
" "${GREEN}${BOLD}" "${RESET}" "$1"; }
log_warn() { printf "%s[WARN]%s %s
" "${YELLOW}${BOLD}" "${RESET}" "$1"; }
on_error() {
  local exit_code="$?"
  printf "%s[FEHLER]%s Abgebrochen in Zeile %s (Exit-Code: %s).
" "${RED}${BOLD}" "${RESET}" "$1" "${exit_code}" >&2
  exit "${exit_code}"
}
trap 'on_error ${LINENO}' ERR

TOTAL_STEPS=3
STEP=0

print_banner
printf "%sBOLZO RMM – Server Installer%s
" "${BOLD}" "${RESET}"
printf "Quelle: %s (Branch: %s)

" "${REPO_URL}" "${BRANCH}"

if [[ "${EUID}" -ne 0 ]]; then
  printf "%sBitte mit sudo/root ausfuehren.%s
" "${RED}${BOLD}" "${RESET}"
  exit 1
fi
command -v systemctl >/dev/null 2>&1 || { printf "%ssystemd wird benoetigt.%s
" "${RED}${BOLD}" "${RESET}"; exit 1; }

log_step "Basis-Tools installieren (curl, git)"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq || log_warn "apt-get update hatte Fehler, fahre fort..."
apt-get install -y -qq ca-certificates curl git >/dev/null
log_ok "Basis-Tools installiert"

log_step "Repository klonen"
rm -rf "${SRC_DIR}"
git clone --quiet --depth 1 --branch "${BRANCH}" "${REPO_URL}" "${SRC_DIR}"
log_ok "Quellcode geladen ($(git -C "${SRC_DIR}" log -1 --format='%h %s'))"

log_step "Server einrichten"
bash "${SRC_DIR}/server/install-server.sh"
rm -rf "${SRC_DIR}"

printf "
%sFertig.%s Melde dich jetzt in der BOLZO-RMM-App mit der oben angezeigten Adresse an.
" "${GREEN}${BOLD}" "${RESET}"
printf "Status:  systemctl status bolzo-rmm
"
printf "Config:  /etc/bolzo-rmm/bolzo-rmm.env
"
printf "Update:  denselben curl-Befehl erneut ausfuehren
"
