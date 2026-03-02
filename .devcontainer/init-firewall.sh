#!/bin/bash
set -euo pipefail

echo "Initializing selftune sandbox firewall..."

# Allow DNS, SSH, localhost
iptables -A OUTPUT -p udp --dport 53 -j ACCEPT
iptables -A OUTPUT -p tcp --dport 53 -j ACCEPT
iptables -A OUTPUT -p tcp --dport 22 -j ACCEPT
iptables -A OUTPUT -o lo -j ACCEPT
iptables -A INPUT -o lo -j ACCEPT

# Allow established connections
iptables -A OUTPUT -m state --state ESTABLISHED,RELATED -j ACCEPT
iptables -A INPUT -m state --state ESTABLISHED,RELATED -j ACCEPT

# Allow HTTPS (port 443) for Claude API, npm, GitHub
iptables -A OUTPUT -p tcp --dport 443 -j ACCEPT

# Allow HTTP (port 80) for package registries
iptables -A OUTPUT -p tcp --dport 80 -j ACCEPT

echo "Firewall initialized."
