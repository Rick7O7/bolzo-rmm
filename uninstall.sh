#!/usr/bin/env bash
# BOLZO RMM – Server deinstallieren
#   curl -fsSL https://raw.githubusercontent.com/Rick7O7/bolzo-rmm/main/uninstall.sh | sudo bash
# Daten (/var/lib/bolzo-rmm) und Konfiguration (/etc/bolzo-rmm) bleiben erhalten.
# Komplett inkl. Daten entfernen:  ... | sudo bash -s -- --purge
set -euo pipefail

PURGE=0
[[ "${1:-}" == "--purge" ]] && PURGE=1

if [[ -t 1 ]] && command -v tput >/dev/null 2>&1 && [[ "$(tput colors 2>/dev/null || echo 0)" -ge 8 ]]; then
  BOLD="$(tput bold)"; RESET="$(tput sgr0)"; RED="$(tput setaf 1)"; GREEN="$(tput setaf 2)"; YELLOW="$(tput setaf 3)"; CYAN="$(tput setaf 6)"
else
  BOLD=""; RESET=""; RED=""; GREEN=""; YELLOW=""; CYAN=""
fi

print_banner() {
  printf "%s\n" "${CYAN}${BOLD}"
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
  printf "%s\n" "${RESET}"
}

log_step() { STEP=$((STEP + 1)); printf "%s[%s/%s]%s %s\n" "${CYAN}${BOLD}" "${STEP}" "${TOTAL_STEPS}" "${RESET}" "$1"; }
log_ok() { printf "%s[OK]%s %s\n" "${GREEN}${BOLD}" "${RESET}" "$1"; }
log_warn() { printf "%s[WARN]%s %s\n" "${YELLOW}${BOLD}" "${RESET}" "$1"; }
on_error() {
  local exit_code="$?"
  printf "%s[FEHLER]%s Abgebrochen in Zeile %s (Exit-Code: %s).\n" "${RED}${BOLD}" "${RESET}" "$1" "${exit_code}" >&2
  exit "${exit_code}"
}
trap 'on_error ${LINENO}' ERR

TOTAL_STEPS=2
STEP=0

print_banner
printf "%sBOLZO RMM – Deinstallation%s\n\n" "${BOLD}" "${RESET}"
[[ "${EUID}" -eq 0 ]] || { printf "%sBitte mit sudo/root ausfuehren.%s\n" "${RED}${BOLD}" "${RESET}"; exit 1; }

log_step "Dienst stoppen und entfernen"
systemctl disable --now bolzo-rmm bolzo-rmm-update.path >/dev/null 2>&1 || true
rm -f /etc/systemd/system/bolzo-rmm.service /etc/systemd/system/bolzo-rmm-update.path /etc/systemd/system/bolzo-rmm-update.service
systemctl daemon-reload
rm -rf /opt/bolzo-rmm /opt/bolzo-rmm-src
log_ok "Programm entfernt"

log_step "Daten"
if [[ "${PURGE}" -eq 1 ]]; then
  rm -rf /var/lib/bolzo-rmm /etc/bolzo-rmm
  userdel bolzo-rmm >/dev/null 2>&1 || true
  log_ok "Daten, Konfiguration und Benutzer geloescht"
else
  log_ok "Daten behalten: /var/lib/bolzo-rmm, /etc/bolzo-rmm (mit --purge komplett loeschen)"
fi
printf "\n%sDeinstallation abgeschlossen.%s\n" "${GREEN}${BOLD}" "${RESET}"
