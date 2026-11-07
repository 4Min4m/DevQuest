/** Security tooling: openssl / update-ca-certificates, trivy, gitleaks, ufw, sshd. */
import { gitleaks } from './gitleaks';
import { sshd, ufw } from './hardening';
import { openssl, updateCaCertificates } from './tls';
import { trivy } from './trivy';

export const securityCommands = [openssl, updateCaCertificates, trivy, gitleaks, ufw, sshd];
