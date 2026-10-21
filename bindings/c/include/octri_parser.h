#ifndef OCTRI_PARSER_H
#define OCTRI_PARSER_H
#include <stddef.h>
#include <stdint.h>
#ifdef __cplusplus
extern "C" {
#endif
typedef struct OctriParserBuffer OctriParserBuffer;
uint32_t octri_parser_abi_version(void);
/* Maximum request/input allocation: 128 MiB. New input bytes are zero-filled. */
OctriParserBuffer *octri_parser_buffer_new(size_t length);
/* Input remains caller-owned and is borrowed only until call returns. */
OctriParserBuffer *octri_parser_call(const uint8_t *data, size_t length);
/* Write only new input buffers. Responses are read-only. No NUL terminator. */
uint8_t *octri_parser_buffer_data(OctriParserBuffer *buffer);
size_t octri_parser_buffer_len(const OctriParserBuffer *buffer);
/* Free once, through the same loaded library. NULL is accepted. */
void octri_parser_buffer_free(OctriParserBuffer *buffer);
#ifdef __cplusplus
}
#endif
#endif
