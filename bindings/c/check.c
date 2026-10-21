/* C ABI lifetime/length checks. Run with AddressSanitizer when available. */
#include "octri_parser.h"
#include <assert.h>
#include <stdlib.h>
#include <string.h>

int main(void) {
    assert(octri_parser_abi_version() == 1);
    assert(octri_parser_buffer_new(0) == NULL);
    assert(octri_parser_buffer_new(128 * 1024 * 1024 + 1) == NULL);
    assert(octri_parser_buffer_data(NULL) == NULL);
    assert(octri_parser_buffer_len(NULL) == 0);
    octri_parser_buffer_free(NULL);
    const char request[] = "{\"abiVersion\":1,\"action\":\"serialize\",\"document\":\"{\\\"x\\\":1}\",\"format\":\"json\"}";
    for (size_t iteration = 0; iteration < 1000; iteration++) {
        size_t length = sizeof(request) - 1;
        OctriParserBuffer *input = octri_parser_buffer_new(length);
        assert(input != NULL);
        memcpy(octri_parser_buffer_data(input), request, length);
        OctriParserBuffer *output = octri_parser_call(octri_parser_buffer_data(input), length);
        octri_parser_buffer_free(input);
        assert(output != NULL);
        size_t size = octri_parser_buffer_len(output);
        char *copy = malloc(size + 1);
        assert(copy != NULL);
        memcpy(copy, octri_parser_buffer_data(output), size);
        copy[size] = 0;
        octri_parser_buffer_free(output);
        assert(strstr(copy, "\"Ok\"") != NULL);
        free(copy);
    }
    return 0;
}
