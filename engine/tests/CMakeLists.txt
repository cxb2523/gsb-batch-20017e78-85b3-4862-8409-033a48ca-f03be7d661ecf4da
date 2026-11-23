# One executable per test file, registered with CTest. A missing source is
# skipped, so test files can be added independently.
#
#   ils_test(<name> [GPU] [LIBS <targets>...] [ARGS <arguments>...])
#
# GPU marks an integration test that needs a model and the GPU: it gets the
# CTest label "gpu" and joins the gpu_tests target instead of unit_tests.

add_custom_target(unit_tests)
add_custom_target(gpu_tests)

function(ils_test name)
    cmake_parse_arguments(T "GPU" "" "LIBS;ARGS" ${ARGN})
    if(NOT EXISTS ${CMAKE_CURRENT_SOURCE_DIR}/${name}.cpp)
        return()
    endif()
    add_executable(${name} ${name}.cpp)
    target_link_libraries(${name} PRIVATE ils_core ${T_LIBS})
    target_compile_options(${name} PRIVATE ${ILS_WARNINGS})
    set_target_properties(${name} PROPERTIES RUNTIME_OUTPUT_DIRECTORY ${CMAKE_BINARY_DIR})
    add_test(NAME ${name} COMMAND ${name} ${T_ARGS} WORKING_DIRECTORY ${CMAKE_SOURCE_DIR})
    set_tests_properties(${name} PROPERTIES TIMEOUT 120)
    if(T_GPU)
        set_tests_properties(${name} PROPERTIES LABELS gpu)
        add_dependencies(gpu_tests ${name})
    else()
        add_dependencies(unit_tests ${name})
    endif()
endfunction()

# Unit tests: no model, no GPU.
ils_test(test_metrics)
ils_test(test_frames)
ils_test(test_tree)
ils_test(test_snapshots)
ils_test(test_log)
ils_test(test_golden ARGS sessions/golden)
ils_test(test_gates)
ils_test(test_session)
ils_test(test_lens)
ils_test(test_server)
# The models folder (reads models/ too, if the files are there) and the
# download checks.
ils_test(test_catalog)
ils_test(test_hf)
ils_test(test_hub)

# The engine with a scripted fake model: serves the real web without a GGUF.
if(EXISTS ${CMAKE_CURRENT_SOURCE_DIR}/fake_engine.cpp)
    add_executable(fake_engine fake_engine.cpp)
    target_link_libraries(fake_engine PRIVATE ils_core ils_web)
    target_compile_options(fake_engine PRIVATE ${ILS_WARNINGS})
    set_target_properties(fake_engine PROPERTIES RUNTIME_OUTPUT_DIRECTORY ${CMAKE_BINARY_DIR})
endif()

# Integration: the test model on the GPU.
if(EXISTS ${CMAKE_CURRENT_SOURCE_DIR}/test_integration.cpp)
    add_library(ils_llama STATIC ${CMAKE_SOURCE_DIR}/engine/src/model.cpp
                                 ${CMAKE_SOURCE_DIR}/engine/src/llama_gates.cpp
                                 ${CMAKE_SOURCE_DIR}/engine/src/llama_lens.cpp)
    target_link_libraries(ils_llama PUBLIC ils_core llama llama-common)
    ils_test(test_integration GPU LIBS ils_llama ARGS models/Qwen3.5-0.8B-Q4_K_M.gguf)
    # Gate fidelity against a llama.cpp sampler chain.
    ils_test(test_fidelity GPU LIBS ils_llama ARGS models/Qwen3.5-0.8B-Q4_K_M.gguf)
    # Branches and placements: a model that cannot trim its context (Qwen3.5,
    # recurrent layers) and one that can (Gemma 4).
    ils_test(test_branches GPU LIBS ils_llama ARGS models/Qwen3.5-0.8B-Q4_K_M.gguf)
    # Logit lens: its last layer against the model's own numbers.
    ils_test(test_lens_coherence GPU LIBS ils_llama ARGS models/Qwen3.5-0.8B-Q4_K_M.gguf)
    if(TARGET test_branches)
        add_test(NAME test_branches_gemma COMMAND test_branches models/google_gemma-4-E4B-it-Q2_K.gguf
                 WORKING_DIRECTORY ${CMAKE_SOURCE_DIR})
        set_tests_properties(test_branches_gemma PROPERTIES TIMEOUT 300 LABELS gpu)
    endif()
endif()
