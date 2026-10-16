/**
 * The OpenID Provider metadata of the TEST-ONLY IdP. One function for both places it is
 * published: the running IdP (`GET /.well-known/openid-configuration`) and the static copy that
 * `sandbox-issuer export` writes for the AWS sandbox issuer (S3 + CloudFront), so the two can
 * never disagree.
 */
export interface DiscoveryDocument {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  end_session_endpoint: string;
  response_types_supported: string[];
  response_modes_supported: string[];
  grant_types_supported: string[];
  code_challenge_methods_supported: string[];
  token_endpoint_auth_methods_supported: string[];
  subject_types_supported: string[];
  id_token_signing_alg_values_supported: string[];
  scopes_supported: string[];
  authorization_response_iss_parameter_supported: boolean;
}

export function discoveryDocument(
  issuer: string,
  algorithm: string,
  apiScopes: readonly string[],
): DiscoveryDocument {
  return {
    issuer,
    authorization_endpoint: `${issuer}/authorize`,
    token_endpoint: `${issuer}/token`,
    jwks_uri: `${issuer}/jwks.json`,
    end_session_endpoint: `${issuer}/logout`,
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    grant_types_supported: ['authorization_code'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    subject_types_supported: ['public'],
    id_token_signing_alg_values_supported: [algorithm],
    scopes_supported: ['openid', 'profile', ...apiScopes],
    authorization_response_iss_parameter_supported: true,
  };
}
