#version 300 es
precision highp float;
precision highp int;

uniform vec3 iResolution;
uniform float iTime;
uniform float iTimeDelta;
uniform vec4 iMouse;
uniform vec4 iDate;

out vec4 st_fragColor;



void main() {
  vec4 n_n_mv2mo7yy21tak = vec4(0.0);
  float n_n_mv2mo7yy0w0th_c_n_dist = (n_n_mv2mo7yy21tak).x;
  vec4 n_n_mv2mo7yy5tkkx = vec4(0.0);
  vec4 n_n_mv2mo7yy0w0th_c_n_acc = n_n_mv2mo7yy5tkkx;
  vec4 n_n_mv2mo7yy0y235 = vec4(0.0);
  vec4 n_n_mv2mo7yy0w0th_c_n_acc2 = n_n_mv2mo7yy0y235;
  float n_n_mv2mo7yy9g7i7 = iTime * 1.0;
  vec2 n_n_mv2mo7yy66nsm = gl_FragCoord.xy / iResolution.xy;
  vec4 n_n_mv2mo7yy8l0rw = vec4(((vec4((n_n_mv2mo7yy66nsm).x, (n_n_mv2mo7yy66nsm).y, 0.0, 1.0)).xy * iResolution.xy * 2.0 - iResolution.xy) / min(iResolution.x, iResolution.y), 0.0, 1.0);
  vec4 n_n_mv2mo7yy53tn8 = vec4(normalize(cross(vec3(0.0, 0.0, -1.0), vec3(sin((vec4(n_n_mv2mo7yy9g7i7)).x), 1.0, 0.0)) * (n_n_mv2mo7yy8l0rw).x + vec3(sin((vec4(n_n_mv2mo7yy9g7i7)).x), 1.0, 0.0) * (n_n_mv2mo7yy8l0rw).y + vec3(0.0, 0.0, -1.0)), 0.0);
  for (int n_n_mv2mo7yy0w0th_i = 0; n_n_mv2mo7yy0w0th_i < 99; n_n_mv2mo7yy0w0th_i++) {
    vec4 n_n_mv2mo7yy0w0th_pos = vec4(vec3(0.0, 0.0, -3.0 * (n_n_mv2mo7yy9g7i7)) + (n_n_mv2mo7yy53tn8).xyz * (vec4(n_n_mv2mo7yy0w0th_c_n_dist)).x, 0.0);
    vec4 n_n_mv2mo7yy0w0th_field_tile = vec4(vec2((mod((n_n_mv2mo7yy0w0th_pos).x - 5.0, 10.0) - 5.0), (mod((n_n_mv2mo7yy0w0th_pos).y - 5.0, 10.0) - 5.0)) * mat2(cos((-(floor((atan((mod((n_n_mv2mo7yy0w0th_pos).x - 5.0, 10.0) - 5.0), (mod((n_n_mv2mo7yy0w0th_pos).y - 5.0, 10.0) - 5.0)) + 0.6283185307179586) / 1.2566370614359172) * 1.2566370614359172))), sin((-(floor((atan((mod((n_n_mv2mo7yy0w0th_pos).x - 5.0, 10.0) - 5.0), (mod((n_n_mv2mo7yy0w0th_pos).y - 5.0, 10.0) - 5.0)) + 0.6283185307179586) / 1.2566370614359172) * 1.2566370614359172))), -sin((-(floor((atan((mod((n_n_mv2mo7yy0w0th_pos).x - 5.0, 10.0) - 5.0), (mod((n_n_mv2mo7yy0w0th_pos).y - 5.0, 10.0) - 5.0)) + 0.6283185307179586) / 1.2566370614359172) * 1.2566370614359172))), cos((-(floor((atan((mod((n_n_mv2mo7yy0w0th_pos).x - 5.0, 10.0) - 5.0), (mod((n_n_mv2mo7yy0w0th_pos).y - 5.0, 10.0) - 5.0)) + 0.6283185307179586) / 1.2566370614359172) * 1.2566370614359172)))), (mod((n_n_mv2mo7yy0w0th_pos).z, 16.0) - 8.0), 0.0);
    vec4 n_n_mv2mo7yy0w0th_field_fold0_abs = vec4(abs((n_n_mv2mo7yy0w0th_field_tile).xyz) - 1.0, 0.0);
    vec4 n_n_mv2mo7yy0w0th_field_fold0_xy = vec4((n_n_mv2mo7yy0w0th_field_fold0_abs).xy * mat2(cos(((vec4(n_n_mv2mo7yy9g7i7)).x * 0.3)), sin(((vec4(n_n_mv2mo7yy9g7i7)).x * 0.3)), -sin(((vec4(n_n_mv2mo7yy9g7i7)).x * 0.3)), cos(((vec4(n_n_mv2mo7yy9g7i7)).x * 0.3))), (n_n_mv2mo7yy0w0th_field_fold0_abs).z, 0.0);
    vec4 n_n_mv2mo7yy0w0th_field_fold0_xz = vec4(((n_n_mv2mo7yy0w0th_field_fold0_xy).xz * mat2(cos(((vec4(n_n_mv2mo7yy9g7i7)).x * 0.1)), sin(((vec4(n_n_mv2mo7yy9g7i7)).x * 0.1)), -sin(((vec4(n_n_mv2mo7yy9g7i7)).x * 0.1)), cos(((vec4(n_n_mv2mo7yy9g7i7)).x * 0.1)))).x, (n_n_mv2mo7yy0w0th_field_fold0_xy).y, ((n_n_mv2mo7yy0w0th_field_fold0_xy).xz * mat2(cos(((vec4(n_n_mv2mo7yy9g7i7)).x * 0.1)), sin(((vec4(n_n_mv2mo7yy9g7i7)).x * 0.1)), -sin(((vec4(n_n_mv2mo7yy9g7i7)).x * 0.1)), cos(((vec4(n_n_mv2mo7yy9g7i7)).x * 0.1)))).y, 0.0);
    vec4 n_n_mv2mo7yy0w0th_field_fold1_abs = vec4(abs((n_n_mv2mo7yy0w0th_field_fold0_xz).xyz) - 1.0, 0.0);
    vec4 n_n_mv2mo7yy0w0th_field_fold1_xy = vec4((n_n_mv2mo7yy0w0th_field_fold1_abs).xy * mat2(cos(((vec4(n_n_mv2mo7yy9g7i7)).x * 0.3)), sin(((vec4(n_n_mv2mo7yy9g7i7)).x * 0.3)), -sin(((vec4(n_n_mv2mo7yy9g7i7)).x * 0.3)), cos(((vec4(n_n_mv2mo7yy9g7i7)).x * 0.3))), (n_n_mv2mo7yy0w0th_field_fold1_abs).z, 0.0);
    vec4 n_n_mv2mo7yy0w0th_field_fold1_xz = vec4(((n_n_mv2mo7yy0w0th_field_fold1_xy).xz * mat2(cos(((vec4(n_n_mv2mo7yy9g7i7)).x * 0.1)), sin(((vec4(n_n_mv2mo7yy9g7i7)).x * 0.1)), -sin(((vec4(n_n_mv2mo7yy9g7i7)).x * 0.1)), cos(((vec4(n_n_mv2mo7yy9g7i7)).x * 0.1)))).x, (n_n_mv2mo7yy0w0th_field_fold1_xy).y, ((n_n_mv2mo7yy0w0th_field_fold1_xy).xz * mat2(cos(((vec4(n_n_mv2mo7yy9g7i7)).x * 0.1)), sin(((vec4(n_n_mv2mo7yy9g7i7)).x * 0.1)), -sin(((vec4(n_n_mv2mo7yy9g7i7)).x * 0.1)), cos(((vec4(n_n_mv2mo7yy9g7i7)).x * 0.1)))).y, 0.0);
    vec4 n_n_mv2mo7yy0w0th_field_fold2_abs = vec4(abs((n_n_mv2mo7yy0w0th_field_fold1_xz).xyz) - 1.0, 0.0);
    vec4 n_n_mv2mo7yy0w0th_field_fold2_xy = vec4((n_n_mv2mo7yy0w0th_field_fold2_abs).xy * mat2(cos(((vec4(n_n_mv2mo7yy9g7i7)).x * 0.3)), sin(((vec4(n_n_mv2mo7yy9g7i7)).x * 0.3)), -sin(((vec4(n_n_mv2mo7yy9g7i7)).x * 0.3)), cos(((vec4(n_n_mv2mo7yy9g7i7)).x * 0.3))), (n_n_mv2mo7yy0w0th_field_fold2_abs).z, 0.0);
    vec4 n_n_mv2mo7yy0w0th_field_fold2_xz = vec4(((n_n_mv2mo7yy0w0th_field_fold2_xy).xz * mat2(cos(((vec4(n_n_mv2mo7yy9g7i7)).x * 0.1)), sin(((vec4(n_n_mv2mo7yy9g7i7)).x * 0.1)), -sin(((vec4(n_n_mv2mo7yy9g7i7)).x * 0.1)), cos(((vec4(n_n_mv2mo7yy9g7i7)).x * 0.1)))).x, (n_n_mv2mo7yy0w0th_field_fold2_xy).y, ((n_n_mv2mo7yy0w0th_field_fold2_xy).xz * mat2(cos(((vec4(n_n_mv2mo7yy9g7i7)).x * 0.1)), sin(((vec4(n_n_mv2mo7yy9g7i7)).x * 0.1)), -sin(((vec4(n_n_mv2mo7yy9g7i7)).x * 0.1)), cos(((vec4(n_n_mv2mo7yy9g7i7)).x * 0.1)))).y, 0.0);
    vec4 n_n_mv2mo7yy0w0th_field_fold3_abs = vec4(abs((n_n_mv2mo7yy0w0th_field_fold2_xz).xyz) - 1.0, 0.0);
    vec4 n_n_mv2mo7yy0w0th_field_fold3_xy = vec4((n_n_mv2mo7yy0w0th_field_fold3_abs).xy * mat2(cos(((vec4(n_n_mv2mo7yy9g7i7)).x * 0.3)), sin(((vec4(n_n_mv2mo7yy9g7i7)).x * 0.3)), -sin(((vec4(n_n_mv2mo7yy9g7i7)).x * 0.3)), cos(((vec4(n_n_mv2mo7yy9g7i7)).x * 0.3))), (n_n_mv2mo7yy0w0th_field_fold3_abs).z, 0.0);
    vec4 n_n_mv2mo7yy0w0th_field_fold3_xz = vec4(((n_n_mv2mo7yy0w0th_field_fold3_xy).xz * mat2(cos(((vec4(n_n_mv2mo7yy9g7i7)).x * 0.1)), sin(((vec4(n_n_mv2mo7yy9g7i7)).x * 0.1)), -sin(((vec4(n_n_mv2mo7yy9g7i7)).x * 0.1)), cos(((vec4(n_n_mv2mo7yy9g7i7)).x * 0.1)))).x, (n_n_mv2mo7yy0w0th_field_fold3_xy).y, ((n_n_mv2mo7yy0w0th_field_fold3_xy).xz * mat2(cos(((vec4(n_n_mv2mo7yy9g7i7)).x * 0.1)), sin(((vec4(n_n_mv2mo7yy9g7i7)).x * 0.1)), -sin(((vec4(n_n_mv2mo7yy9g7i7)).x * 0.1)), cos(((vec4(n_n_mv2mo7yy9g7i7)).x * 0.1)))).y, 0.0);
    vec4 n_n_mv2mo7yy0w0th_field_fold4_abs = vec4(abs((n_n_mv2mo7yy0w0th_field_fold3_xz).xyz) - 1.0, 0.0);
    vec4 n_n_mv2mo7yy0w0th_field_fold4_xy = vec4((n_n_mv2mo7yy0w0th_field_fold4_abs).xy * mat2(cos(((vec4(n_n_mv2mo7yy9g7i7)).x * 0.3)), sin(((vec4(n_n_mv2mo7yy9g7i7)).x * 0.3)), -sin(((vec4(n_n_mv2mo7yy9g7i7)).x * 0.3)), cos(((vec4(n_n_mv2mo7yy9g7i7)).x * 0.3))), (n_n_mv2mo7yy0w0th_field_fold4_abs).z, 0.0);
    vec4 n_n_mv2mo7yy0w0th_field_fold4_xz = vec4(((n_n_mv2mo7yy0w0th_field_fold4_xy).xz * mat2(cos(((vec4(n_n_mv2mo7yy9g7i7)).x * 0.1)), sin(((vec4(n_n_mv2mo7yy9g7i7)).x * 0.1)), -sin(((vec4(n_n_mv2mo7yy9g7i7)).x * 0.1)), cos(((vec4(n_n_mv2mo7yy9g7i7)).x * 0.1)))).x, (n_n_mv2mo7yy0w0th_field_fold4_xy).y, ((n_n_mv2mo7yy0w0th_field_fold4_xy).xz * mat2(cos(((vec4(n_n_mv2mo7yy9g7i7)).x * 0.1)), sin(((vec4(n_n_mv2mo7yy9g7i7)).x * 0.1)), -sin(((vec4(n_n_mv2mo7yy9g7i7)).x * 0.1)), cos(((vec4(n_n_mv2mo7yy9g7i7)).x * 0.1)))).y, 0.0);
    vec4 n_n_mv2mo7yy0w0th_field_finalrot = vec4(((n_n_mv2mo7yy0w0th_field_fold4_xz).xz * mat2(cos((vec4(n_n_mv2mo7yy9g7i7)).x), sin((vec4(n_n_mv2mo7yy9g7i7)).x), -sin((vec4(n_n_mv2mo7yy9g7i7)).x), cos((vec4(n_n_mv2mo7yy9g7i7)).x))).x, (n_n_mv2mo7yy0w0th_field_fold4_xz).y, ((n_n_mv2mo7yy0w0th_field_fold4_xz).xz * mat2(cos((vec4(n_n_mv2mo7yy9g7i7)).x), sin((vec4(n_n_mv2mo7yy9g7i7)).x), -sin((vec4(n_n_mv2mo7yy9g7i7)).x), cos((vec4(n_n_mv2mo7yy9g7i7)).x))).y, 0.0);
    vec4 n_n_mv2mo7yy0w0th_field_boxd = vec4(abs((n_n_mv2mo7yy0w0th_field_finalrot).xyz) - vec3(0.4, 0.8, 0.3), 0.0);
    vec4 n_n_mv2mo7yy0w0th_field_box = vec4(min(max((n_n_mv2mo7yy0w0th_field_boxd).x, max((n_n_mv2mo7yy0w0th_field_boxd).y, (n_n_mv2mo7yy0w0th_field_boxd).z)), 0.0) + length(max((n_n_mv2mo7yy0w0th_field_boxd).xyz, 0.0)), 0.0, 0.0, 1.0);
    vec4 n_n_mv2mo7yy0w0th_step = vec4((vec4(n_n_mv2mo7yy0w0th_c_n_dist)).x + max(abs((vec4((n_n_mv2mo7yy0w0th_field_box).x)).x), 0.02) * 0.5, max(abs((vec4((n_n_mv2mo7yy0w0th_field_box).x)).x), 0.02), 0.0, 0.0);
    vec4 n_n_mv2mo7yy0w0th_glow = vec4(exp(-(n_n_mv2mo7yy0w0th_step).y * 3.0), 0.0, 0.0, 1.0);
    vec4 n_n_mv2mo7yy0w0th_pulse = vec4(step(mod(length((n_n_mv2mo7yy0w0th_pos).xyz) + 24.0 * (vec4(n_n_mv2mo7yy9g7i7)).x, 30.0), 3.0), 0.0, 0.0, 1.0);
    vec4 n_n_mv2mo7yy0w0th_aeff = vec4((n_n_mv2mo7yy0w0th_glow).x * (1.0 + (n_n_mv2mo7yy0w0th_pulse).x * 1.0), 0.0, 0.0, 1.0);
    vec4 n_n_mv2mo7yy0w0th_acc_new = vec4((n_n_mv2mo7yy0w0th_c_n_acc).x + (n_n_mv2mo7yy0w0th_aeff).x, 0.0, 0.0, 1.0);
    vec4 n_n_mv2mo7yy0w0th_acc2_new = vec4((n_n_mv2mo7yy0w0th_c_n_acc2).x + (n_n_mv2mo7yy0w0th_aeff).x * ((n_n_mv2mo7yy0w0th_pulse).x), 0.0, 0.0, 1.0);
    n_n_mv2mo7yy0w0th_c_n_dist = (n_n_mv2mo7yy0w0th_step).x;
    n_n_mv2mo7yy0w0th_c_n_acc = n_n_mv2mo7yy0w0th_acc_new;
    n_n_mv2mo7yy0w0th_c_n_acc2 = n_n_mv2mo7yy0w0th_acc2_new;
  }
  vec4 n_n_mv2mo7yy18bye = vec4(vec3((n_n_mv2mo7yy0w0th_c_n_acc).x, (n_n_mv2mo7yy0w0th_c_n_acc).x * 1.1 + (n_n_mv2mo7yy0w0th_c_n_acc2).x * 0.2, (n_n_mv2mo7yy0w0th_c_n_acc).x * 1.2 + (n_n_mv2mo7yy0w0th_c_n_acc2).x * 0.5) * 0.01000, 1.0);
  st_fragColor = n_n_mv2mo7yy18bye;
}