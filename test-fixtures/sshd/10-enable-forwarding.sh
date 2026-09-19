#!/bin/bash
# Образ linuxserver/openssh-server закрывает проброс портов по умолчанию.
# Реестру он нужен: база за SSH достижима только через туннель.
sed -i 's/^AllowTcpForwarding no/AllowTcpForwarding yes/' /config/sshd/sshd_config
