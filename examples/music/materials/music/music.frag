#version 300 es
precision highp float;
precision highp int;

uniform vec3 iResolution;
uniform float iTime;
uniform float iTimeDelta;
uniform vec4 iMouse;
uniform vec4 iDate;
uniform sampler2D iChannel0;
uniform sampler2D BufferA;

out vec4 st_fragColor;



void main() {
  vec2 n_n_show_uv = gl_FragCoord.xy / iResolution.xy;
  vec2 n_n_uv2 = gl_FragCoord.xy / iResolution.xy;
  vec4 n_n_bars2 = vec4(vec3(0.45, 0.28, 0.95) * step((vec4((n_n_uv2).x, (n_n_uv2).y, 0.0, 1.0)).y, pow(texture(iChannel0, vec2(floor((vec4((n_n_uv2).x, (n_n_uv2).y, 0.0, 1.0)).x * 96.0) / 96.0, 0.0)).x, 1.4) * 0.20) * step(0.0, (vec4((n_n_uv2).x, (n_n_uv2).y, 0.0, 1.0)).y) * (0.55 + 0.45 * (vec4((n_n_uv2).x, (n_n_uv2).y, 0.0, 1.0)).y), 1.0) + vec4(vec3(0.10, 0.05, 0.25) * smoothstep(0.14, 0.0, (vec4((n_n_uv2).x, (n_n_uv2).y, 0.0, 1.0)).y), 0.0);
  vec4 n_n_audio2 = vec4(texture(iChannel0, vec2(0.03, 0.0)).x, texture(iChannel0, vec2(0.12, 0.0)).x, texture(iChannel0, vec2(0.40, 0.0)).x, texture(iChannel0, vec2((vec4((n_n_uv2).x, (n_n_uv2).y, 0.0, 1.0)).x, 1.0)).x);
  vec4 n_n_wave2 = vec4(vec3(0.85, 0.55, 0.95) * smoothstep(0.0035, 0.0, abs((vec4((n_n_uv2).x, (n_n_uv2).y, 0.0, 1.0)).y - (0.86 + (n_n_audio2).w * 0.06))) * 0.85, 1.0);
  vec4 n_n_composite2 = vec4((texture(BufferA, n_n_show_uv)).rgb + (n_n_bars2).rgb + vec3(((n_n_wave2).x)), 1.0);
  vec4 n_n_tint2 = vec4(min(vec3(1.0), vec3(dot((n_n_composite2).rgb, vec3(0.5, 0.8, 1.0)) * (0.35 + 0.4 * (n_n_audio2).y), dot((n_n_composite2).rgb, vec3(1.0, 0.4, 0.9)) * (0.35 + 0.4 * (n_n_audio2).z), dot((n_n_composite2).rgb, vec3(0.3, 0.6, 1.0)) * (0.35 + 0.4 * (n_n_audio2).x))), 1.0);
  st_fragColor = n_n_tint2;
}